#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.

import { appendFileSync, readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, mkdirSync, lstatSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve, delimiter } from 'path';
import { spawn, spawnSync } from 'child_process';
import net from 'net';
import { autoActionJsonArgs as autoActionJsonArgsForCommands } from './lib/action-evidence.mjs';
import {
  receiptForActionJson,
  receiptForReport,
} from './lib/action-receipt-surfaces.mjs';
import {
  actionFailureInput,
  actionFailureMessage,
  actionTargetCommandId,
  actionTargetCommandPrefix,
  buildActionRecoveryPlan,
  buildNoChangeOutcomeRecommendation,
  classifyActionFailure,
  formatActionFailure,
  isTimeoutError,
  recoveryCommandsFromDiagnosis,
  uniqueNextStepCommands,
} from './lib/action-recovery.mjs';
import {
  createPerceptionModel,
  formatPerceptionJson,
  goldenPathActRecommendation,
  goldenPathBrowserPermissionRecommendation,
  goldenPathOpenPageRecommendation,
  goldenPathPerceiveRecommendation,
} from './lib/perception-model.mjs';
import {
  buildReportRecommendation,
  defaultReportNextSteps,
  formatReportNextStepLines,
  formatReportRecommendationLines,
  normalizeReportTargetCommand,
} from './lib/session-report.mjs';

const TIMEOUT = 15000;
const SCREENSHOT_TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 30000;
const RELOAD_EVENT_TIMEOUT = 1000;
const RELOAD_DISPATCH_TIMEOUT = 1000;
const RELOAD_READY_TIMEOUT = 1000;
const RELOAD_READY_PROBE_TIMEOUT = 500;
const RELOAD_OBSERVE_TIMEOUT = 2000;
const STATUS_PAGE_INFO_TIMEOUT = 500;
const REF_RESOLVE_TIMEOUT = 2000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const FIRE_AND_FORGET_KEEPALIVE = 60 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const DAEMON_ALLOW_RETRIES = 200;  // For open --attach: 200 * 300ms = 60s
const DAEMON_ALLOW_DELAY = 300;
const DEFAULT_OPEN_ATTACH_TIMEOUT_MS = DAEMON_ALLOW_RETRIES * DAEMON_ALLOW_DELAY;
const DEFAULT_OPEN_READY_TIMEOUT_MS = 5000;
const MIN_TARGET_PREFIX_LEN = 8;
const MAX_ACTION_LOG_ENTRIES = 100;
const MAX_ENVIRONMENT_LOG_ENTRIES = 100;
const MAX_SCREENSHOT_ENTRIES = 100;
const MAX_NETWORK_MOCK_HITS = 50;
const IS_WINDOWS = process.platform === 'win32';
if (!IS_WINDOWS) process.umask(0o077);
const RUNTIME_DIR = IS_WINDOWS
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'cdp')
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'cdp')
    : resolve(homedir(), '.cache', 'cdp');
try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }); } catch {}
const SOCK_PREFIX = resolve(RUNTIME_DIR, 'cdp-');
const PAGES_CACHE = resolve(RUNTIME_DIR, 'pages.json');
const ALIASES_CACHE = resolve(RUNTIME_DIR, 'aliases.json');
const DAEMON_METADATA_SCHEMA = 'chrome-cdp-ex.daemon-metadata.v1';
const ALLOW_STALE_DAEMON_FLAG = '--allow-stale-daemon';
const DEFAULT_CDP_HOST = '127.0.0.1';
const DEFAULT_SPAWN_READY_TIMEOUT_MS = 5000;

class RingBuffer {
  constructor(capacity) { this.buf = []; this.capacity = capacity; this.seq = 0; }
  push(entry) { entry._seq = ++this.seq; this.buf.push(entry); if (this.buf.length > this.capacity) this.buf.shift(); }
  since(seq) { return this.buf.filter(e => e._seq > seq); }
  all() { return [...this.buf]; }
  latest() { return this.seq; }
  clear() { this.buf.length = 0; }
}

function sockPath(targetId) {
  if (IS_WINDOWS) return `\\\\.\\pipe\\cdp-${targetId}`;
  return `${SOCK_PREFIX}${targetId}.sock`;
}

function emptyAliasStore() {
  return {
    schema: 'chrome-cdp-ex.aliases.v1',
    current: null,
    aliases: {},
  };
}

function normalizeAliasName(name) {
  const value = String(name || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    throw new Error('alias name must start with a letter and contain only letters, numbers, dot, dash, or underscore');
  }
  return value;
}

function normalizeAliasStore(raw) {
  const store = raw && typeof raw === 'object' ? raw : {};
  const aliases = {};
  for (const [name, alias] of Object.entries(store.aliases || {})) {
    if (!alias?.targetId) continue;
    aliases[name] = {
      name,
      targetId: String(alias.targetId),
      targetPrefix: String(alias.targetPrefix || alias.targetId).slice(0, 8),
      port: alias.port == null || alias.port === '' ? null : Number(alias.port),
      host: alias.host || null,
      url: alias.url || '',
      title: alias.title || '',
      createdAt: alias.createdAt || null,
      updatedAt: alias.updatedAt || null,
    };
  }
  const current = store.current && aliases[store.current] ? store.current : null;
  return { ...emptyAliasStore(), aliases, current };
}

function readTargetAliases({ path = ALIASES_CACHE, reader = readFileSync } = {}) {
  try {
    return normalizeAliasStore(JSON.parse(reader(path, 'utf8')));
  } catch {
    return emptyAliasStore();
  }
}

function writeTargetAliases(store, { path = ALIASES_CACHE, writer = writeFileSync } = {}) {
  const normalized = normalizeAliasStore(store);
  writer(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

function upsertTargetAlias(store = emptyAliasStore(), record = {}) {
  const normalized = normalizeAliasStore(store);
  const name = normalizeAliasName(record.name);
  if (!record.targetId) throw new Error('alias targetId is required');
  const now = new Date(record.now || Date.now()).toISOString();
  const previous = normalized.aliases[name] || {};
  normalized.aliases[name] = {
    name,
    targetId: String(record.targetId),
    targetPrefix: String(record.targetId).slice(0, 8),
    port: record.port == null || record.port === '' ? null : Number(record.port),
    host: record.host || null,
    url: record.url || previous.url || '',
    title: record.title || previous.title || '',
    createdAt: previous.createdAt || now,
    updatedAt: now,
  };
  normalized.current = name;
  return normalized;
}

function removeTargetAlias(store = emptyAliasStore(), name) {
  const normalized = normalizeAliasStore(store);
  const aliasName = normalizeAliasName(name);
  delete normalized.aliases[aliasName];
  if (normalized.current === aliasName) normalized.current = Object.keys(normalized.aliases)[0] || null;
  return normalized;
}

function resolveTargetAlias(name, store = readTargetAliases()) {
  const key = String(name || '').trim();
  if (!key) return null;
  const normalized = normalizeAliasStore(store);
  if (key === 'current' && normalized.current) return normalized.aliases[normalized.current] || null;
  return normalized.aliases[key] || null;
}

function aliasesForTarget(targetId, aliases = {}) {
  return Object.values(aliases || {})
    .filter(alias => alias?.targetId === targetId)
    .map(alias => alias.name)
    .sort();
}

function aliasEnv(alias, baseEnv = process.env) {
  if (!alias?.port) return baseEnv;
  return {
    ...baseEnv,
    CDP_PORT: String(alias.port),
    ...(alias.host ? { CDP_HOST: alias.host } : {}),
  };
}

function parseAliasCommandArgs(args = [], mode = 'use') {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const parsed = {
    mode,
    format: fopts.format,
    name: null,
    targetId: null,
    port: null,
    host: null,
  };
  const positional = [];
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--name' || token === '-n') parsed.name = fopts.args[++i] || null;
    else if (token === '--target' || token === '-t') parsed.targetId = fopts.args[++i] || null;
    else if (token === '--port' || token === '-p') parsed.port = Number(fopts.args[++i]);
    else if (token === '--host') parsed.host = fopts.args[++i] || null;
    else if (String(token).startsWith('--')) throw new Error(`${mode}: unknown argument ${token}`);
    else positional.push(token);
  }
  if (!parsed.targetId && positional[0]) {
    const slash = String(positional[0]).match(/^(\d+)\/(.+)$/);
    if (slash) {
      parsed.port = Number(slash[1]);
      parsed.targetId = slash[2];
    } else {
      parsed.targetId = positional[0];
    }
  }
  if (!parsed.name && mode === 'use') parsed.name = positional[1] || 'current';
  if (!parsed.name) throw new Error(`${mode}: --name is required`);
  if (!parsed.targetId) throw new Error(`${mode}: --target or target id is required`);
  if (parsed.port != null && (!Number.isInteger(parsed.port) || parsed.port <= 0 || parsed.port > 65535)) {
    throw new Error(`${mode}: --port must be a TCP port`);
  }
  return parsed;
}

function formatAliasRecord(alias, { format = 'text' } = {}) {
  if (format === 'json') return formatJson({ schema: 'chrome-cdp-ex.alias.v1', alias });
  const parts = [`Alias @${alias.name}: ${alias.targetPrefix}`];
  if (alias.port) parts.push(`CDP_PORT=${alias.port}`);
  if (alias.url) parts.push(alias.url);
  return parts.join('  ');
}

function formatCurrentAlias(store, { format = 'text' } = {}) {
  const normalized = normalizeAliasStore(store);
  const current = normalized.current ? normalized.aliases[normalized.current] : null;
  if (format === 'json') {
    return formatJson({
      schema: 'chrome-cdp-ex.alias-current.v1',
      current: current || null,
      aliases: Object.values(normalized.aliases),
    });
  }
  if (!current) return 'No current alias. Run: cdp use <target> --name app';
  return formatAliasRecord(current);
}

// ---------------------------------------------------------------------------
// tab-group / broadcast — multi-tab coordination
// ---------------------------------------------------------------------------

const TAB_GROUPS_CACHE = resolve(RUNTIME_DIR, 'tab-groups.json');

function emptyTabGroupStore() {
  return { schema: 'chrome-cdp-ex.tab-groups.v1', groups: {} };
}

function normalizeTabGroupName(name) {
  const value = String(name || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    throw new Error('tab-group name must start with a letter and contain only letters, numbers, dot, dash, or underscore');
  }
  return value;
}

function normalizeTabGroupStore(raw) {
  const store = raw && typeof raw === 'object' ? raw : {};
  const groups = {};
  for (const [name, group] of Object.entries(store.groups || {})) {
    if (!group) continue;
    const members = Array.isArray(group.members)
      ? [...new Set(group.members.map(m => String(m || '').trim()).filter(Boolean))]
      : [];
    groups[name] = {
      name,
      members,
      createdAt: group.createdAt || null,
      updatedAt: group.updatedAt || null,
    };
  }
  return { ...emptyTabGroupStore(), groups };
}

function readTabGroups({ path = TAB_GROUPS_CACHE, reader = readFileSync } = {}) {
  try {
    return normalizeTabGroupStore(JSON.parse(reader(path, 'utf8')));
  } catch {
    return emptyTabGroupStore();
  }
}

function writeTabGroups(store, { path = TAB_GROUPS_CACHE, writer = writeFileSync } = {}) {
  const normalized = normalizeTabGroupStore(store);
  writer(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

function upsertTabGroup(store = emptyTabGroupStore(), { name, members = [], now = Date.now() } = {}) {
  const normalized = normalizeTabGroupStore(store);
  const groupName = normalizeTabGroupName(name);
  const previous = normalized.groups[groupName] || {};
  const ts = new Date(now).toISOString();
  const nextMembers = [...new Set([...(previous.members || []), ...members.map(String)])].filter(Boolean);
  normalized.groups[groupName] = {
    name: groupName,
    members: nextMembers,
    createdAt: previous.createdAt || ts,
    updatedAt: ts,
  };
  return normalized;
}

function removeTabGroupMember(store = emptyTabGroupStore(), name, member, { now = Date.now() } = {}) {
  const normalized = normalizeTabGroupStore(store);
  const groupName = normalizeTabGroupName(name);
  const group = normalized.groups[groupName];
  if (!group) throw new Error(`tab-group: unknown group "${groupName}"`);
  group.members = group.members.filter(m => m !== String(member));
  group.updatedAt = new Date(now).toISOString();
  return normalized;
}

function deleteTabGroup(store = emptyTabGroupStore(), name) {
  const normalized = normalizeTabGroupStore(store);
  const groupName = normalizeTabGroupName(name);
  if (!normalized.groups[groupName]) throw new Error(`tab-group: unknown group "${groupName}"`);
  delete normalized.groups[groupName];
  return normalized;
}

function getTabGroup(store = emptyTabGroupStore(), name) {
  const normalized = normalizeTabGroupStore(store);
  const groupName = normalizeTabGroupName(name);
  return normalized.groups[groupName] || null;
}

function parseTabGroupArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const [action, ...rest] = fopts.args;
  if (!action) throw new Error('tab-group: action required (list|create|add|remove|delete|show)');
  const actionName = String(action).toLowerCase();
  if (!['list', 'create', 'add', 'remove', 'delete', 'show'].includes(actionName)) {
    throw new Error(`tab-group: unknown action ${action}`);
  }
  return { format: fopts.format, action: actionName, args: rest };
}

function formatTabGroupStore(store, { format = 'text' } = {}) {
  const normalized = normalizeTabGroupStore(store);
  const groups = Object.values(normalized.groups).sort((a, b) => a.name.localeCompare(b.name));
  if (format === 'json') {
    return formatJson({
      schema: 'chrome-cdp-ex.tab-groups.v1',
      groupCount: groups.length,
      groups,
    });
  }
  if (!groups.length) return 'No tab groups. Create one: cdp tab-group create app <target> [<target>...]';
  return groups.map(g => `${g.name}  (${g.members.length})  ${g.members.join(', ') || '(empty)'}`).join('\n');
}

function formatTabGroup(group, { format = 'text' } = {}) {
  if (!group) throw new Error('tab-group: group required');
  if (format === 'json') return formatJson({ schema: 'chrome-cdp-ex.tab-group.v1', group });
  return [
    `Tab group: ${group.name}`,
    `Members (${group.members.length}): ${group.members.join(', ') || '(empty)'}`,
    group.updatedAt ? `Updated: ${group.updatedAt}` : null,
  ].filter(Boolean).join('\n');
}

function parseBroadcastArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const fullResults = fopts.args.includes('--full-results');
  const filtered = fopts.args.filter(arg => arg !== '--full-results');
  const [groupName, ...cmdParts] = filtered;
  if (!groupName) throw new Error('broadcast: group name required');
  if (!cmdParts.length) throw new Error('broadcast: command required (e.g. broadcast app perceive -C -d 4)');
  return {
    format: fopts.format,
    groupName: normalizeTabGroupName(groupName),
    command: cmdParts[0],
    commandArgs: cmdParts.slice(1),
    fullResults,
  };
}

function buildBroadcastModel({ groupName, command, commandArgs = [], results = [], fullResults = false } = {}) {
  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;
  const boundedResults = results.map((entry) => {
    if (fullResults) return { ...entry };
    const { result, error, ...rest } = entry;
    const bounded = { ...rest };
    if (result != null) {
      const text = String(result);
      bounded.resultPreview = text.slice(0, 240);
      bounded.resultChars = text.length;
      bounded.resultTruncated = text.length > 240;
    }
    if (error != null) {
      const text = String(error);
      bounded.errorPreview = text.slice(0, 240);
      bounded.errorChars = text.length;
      bounded.errorTruncated = text.length > 240;
    }
    return bounded;
  });
  return {
    schema: 'chrome-cdp-ex.broadcast.v1',
    group: groupName,
    command,
    commandArgs,
    fullResults,
    count: results.length,
    ok,
    failed,
    results: boundedResults,
    nextSteps: failed
      ? results.filter(r => !r.ok).slice(0, 3).map(r => formatCommandLine(['cdp', command, r.targetPrefix, ...commandArgs]))
      : [`cdp tab-group show ${groupName}`],
  };
}

function formatBroadcastResult(model) {
  const lines = [
    `Broadcast ${model.group}: ${model.command} → ${model.ok}/${model.count} ok` +
      (model.failed ? `, ${model.failed} failed` : ''),
  ];
  for (const entry of model.results || []) {
    const head = entry.ok ? 'OK' : 'ERR';
    const preview = String(entry.result || entry.resultPreview || entry.error || entry.errorPreview || '').split('\n')[0].slice(0, 160);
    lines.push(`  [${head}] ${entry.targetPrefix}: ${preview}`);
  }
  return lines.join('\n');
}

function isBlankPageUrl(url = '') {
  const value = String(url || '').trim();
  return !value || value === 'about:blank' || value === 'about:srcdoc';
}

function pageTargetScore(page = {}) {
  let score = 0;
  const url = page.url || '';
  const title = page.title || '';
  if (!isBlankPageUrl(url)) score += 100;
  if (title && title !== '(blank tab)') score += 20;
  if (/^https?:\/\//i.test(url)) score += 10;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url)) score += 5;
  if (page.attached === true || page.attached === 1) score += 3;
  if (typeof page.lastAccessTime === 'number') score += Math.min(10, Math.floor(page.lastAccessTime / 1e12));
  return score;
}

function rankPageTargets(pages = []) {
  return [...pages].sort((a, b) => {
    const scoreDiff = pageTargetScore(b) - pageTargetScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return String(a.targetId || '').localeCompare(String(b.targetId || ''));
  });
}

function pageMatchesUrl(page = {}, needle = '', { exact = false } = {}) {
  const url = String(page.url || '');
  const want = String(needle || '');
  if (!want) return false;
  if (exact) return url === want || url === want.replace(/\/$/, '') || url.replace(/\/$/, '') === want;
  return url.toLowerCase().includes(want.toLowerCase());
}

function pageMatchesTitle(page = {}, needle = '', { exact = false } = {}) {
  const title = String(page.title || '');
  const want = String(needle || '');
  if (!want) return false;
  if (exact) return title === want;
  return title.toLowerCase().includes(want.toLowerCase());
}

function matchPageTargets(pages = [], { url = null, title = null, exact = false } = {}) {
  return (pages || []).filter(page => {
    if (url && !pageMatchesUrl(page, url, { exact })) return false;
    if (title && !pageMatchesTitle(page, title, { exact })) return false;
    return true;
  });
}

function formatTargetCandidateLine(page, prefixLength = 8) {
  const prefix = String(page.targetId || '').slice(0, prefixLength);
  const title = isBlankPageUrl(page.url) ? '(blank tab)' : (page.title || '(untitled)');
  return `${prefix}  ${title}  ${page.url || ''}`;
}

function selectPageTarget(pages = [], opts = {}) {
  const { url = null, title = null, exact = false } = opts;
  if (!url && !title) {
    throw new Error('target: provide --url and/or --title to select a page');
  }
  const matches = matchPageTargets(pages, { url, title, exact });
  const ranked = rankPageTargets(matches);
  const prefixLength = getDisplayPrefixLength((pages || []).map(p => p.targetId || ''));
  if (ranked.length === 0) {
    const filters = [
      url ? `--url ${url}` : null,
      title ? `--title ${JSON.stringify(title)}` : null,
      exact ? '--exact' : null,
    ].filter(Boolean).join(' ');
    throw new Error(`target: no page matched ${filters}. Run: cdp list`);
  }
  if (ranked.length > 1) {
    const lines = ranked.slice(0, 8).map(page => `  ${formatTargetCandidateLine(page, prefixLength)}`);
    const more = ranked.length > lines.length ? `\n  … +${ranked.length - lines.length} more` : '';
    throw new Error([
      `target: ${ranked.length} pages matched; narrow with a more specific --url/--title or --exact`,
      'Candidates:',
      ...lines,
      more,
      `Follow-up: cdp list --format json`,
      `Or: cdp target --url <more-specific-url> --format json`,
    ].filter(Boolean).join('\n'));
  }
  const chosen = ranked[0];
  return {
    page: chosen,
    targetId: chosen.targetId,
    targetPrefix: String(chosen.targetId || '').slice(0, prefixLength),
    matchCount: 1,
    filters: { url, title, exact },
  };
}

function parseTargetSelectArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const parsed = {
    format: fopts.format,
    url: null,
    title: null,
    exact: false,
  };
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--url' || token === '-u') parsed.url = fopts.args[++i] || null;
    else if (token === '--title' || token === '-t') parsed.title = fopts.args[++i] || null;
    else if (token === '--exact') parsed.exact = true;
    else throw new Error(`target: unknown argument ${token}`);
  }
  if (!parsed.url && !parsed.title) throw new Error('target: provide --url and/or --title');
  return parsed;
}

function buildTargetSelectModel(selection, pages = []) {
  const page = selection.page || {};
  const prefixLength = getDisplayPrefixLength((pages || []).map(p => p.targetId || ''));
  return {
    schema: 'chrome-cdp-ex.target-select.v1',
    targetId: selection.targetId,
    targetPrefix: selection.targetPrefix || String(selection.targetId || '').slice(0, prefixLength),
    title: isBlankPageUrl(page.url) ? '(blank tab)' : (page.title || ''),
    url: page.url || '',
    isBlank: isBlankPageUrl(page.url),
    matchCount: selection.matchCount || 1,
    filters: selection.filters || {},
    recommendation: goldenPathPerceiveRecommendation(selection.targetPrefix || String(selection.targetId || '').slice(0, 8)),
    nextSteps: [
      `cdp perceive ${selection.targetPrefix || String(selection.targetId || '').slice(0, 8)} -C -d 8`,
      `cdp use ${selection.targetPrefix || String(selection.targetId || '').slice(0, 8)} --name app`,
    ],
  };
}

function formatTargetSelect(selection, pages = [], { format = 'text' } = {}) {
  const model = buildTargetSelectModel(selection, pages);
  if (format === 'json') return formatJson(model);
  return [
    `Selected target: ${model.targetPrefix}`,
    `URL: ${model.url || '(unknown)'}`,
    `Title: ${model.title || '(untitled)'}`,
    `Next: ${model.nextSteps[0]}`,
  ].join('\n');
}

function parseQaModeArgs(args = [], allowed = ['text', 'json']) {
  const fopts = parseFormatArgs(args, allowed);
  let qa = false;
  let summary = false;
  let compact = false;
  let maxDiffLines = null;
  let maxControls = null;
  const next = [];
  for (let i = 0; i < fopts.args.length; i++) {
    const arg = fopts.args[i];
    if (arg === '--qa') qa = true;
    else if (arg === '--summary') summary = true;
    else if (arg === '--compact') compact = true;
    else if (arg === '--max-diff-lines') {
      maxDiffLines = parseNonNegativeInteger(fopts.args[++i], '--max-diff-lines');
    } else if (String(arg).startsWith('--max-diff-lines=')) {
      maxDiffLines = parseNonNegativeInteger(String(arg).slice('--max-diff-lines='.length), '--max-diff-lines');
    } else if (arg === '--max-controls') {
      maxControls = parseNonNegativeInteger(fopts.args[++i], '--max-controls');
    } else if (String(arg).startsWith('--max-controls=')) {
      maxControls = parseNonNegativeInteger(String(arg).slice('--max-controls='.length), '--max-controls');
    } else next.push(arg);
  }
  return {
    format: fopts.format,
    qa: qa || summary,
    summary: summary || qa,
    compact: compact || qa || summary,
    maxDiffLines,
    maxControls,
    args: next,
  };
}

function buildQaSummaryModel({
  page = {},
  console: consoleHealth = {},
  network = {},
  action = null,
  blank = null,
  nextCommand = null,
  targetPrefix = null,
  source = 'qa-summary',
} = {}) {
  const url = page.url || '';
  const title = page.title || '';
  const isBlank = blank == null ? isBlankPageUrl(url) : Boolean(blank);
  const consoleErrors = Number(consoleHealth.errors || 0) + Number(consoleHealth.exceptions || 0);
  const networkFailures = Number(network.failures || 0);
  const changed = action?.outcome
    ? !['no-change', 'failed', 'timeout'].includes(action.outcome)
    : action?.changed;
  const changedStatus = changed == null ? 'unknown' : (changed ? 'changed' : 'no-change');
  const ok = !isBlank && consoleErrors === 0 && networkFailures === 0 && action?.dispatch?.ok !== false;
  return {
    schema: 'chrome-cdp-ex.qa-summary.v1',
    source,
    targetPrefix: targetPrefix || null,
    page: { url, title, isBlank },
    consoleErrors,
    networkFailures,
    changed: changedStatus,
    ok,
    nextCommand: nextCommand || (targetPrefix ? `cdp report ${targetPrefix}` : null),
  };
}

function formatQaSummaryText(model) {
  return [
    `QA summary: ${model.ok ? 'pass' : 'review'}`,
    `Page: ${model.page?.title || '(untitled)'}`,
    `URL: ${model.page?.url || '(unknown)'}${model.page?.isBlank ? ' (blank)' : ''}`,
    `Console errors: ${model.consoleErrors}`,
    `Network failures: ${model.networkFailures}`,
    `Changed: ${model.changed}`,
    model.nextCommand ? `Next: ${model.nextCommand}` : null,
  ].filter(Boolean).join('\n');
}

function truncateTextLines(text = '', maxLines = null) {
  if (maxLines == null || maxLines < 0) return String(text || '');
  const lines = String(text || '').split('\n');
  if (lines.length <= maxLines) return lines.join('\n');
  return [...lines.slice(0, maxLines), `… truncated ${lines.length - maxLines} lines`].join('\n');
}

// Browser metadata from /json/version — set when connecting via CDP_PORT
let _browserInfo = null;

async function getWsUrl() {
  const host = process.env.CDP_HOST || DEFAULT_CDP_HOST;

  // CDP_PORT: explicit port (e.g. Electron with --remote-debugging-port=9222)
  if (process.env.CDP_PORT) {
    const port = process.env.CDP_PORT;
    let res;
    try {
      res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    } catch {
      throw new Error(`Cannot reach CDP on ${host}:${port} — is the app running with --remote-debugging-port=${port}?`);
    }
    const info = await res.json();
    if (!info.webSocketDebuggerUrl) throw new Error(`CDP on port ${port}: /json/version has no webSocketDebuggerUrl`);
    _browserInfo = info;
    // Extract path only — don't trust the hostname in the response (may be "localhost"
    // while CDP_HOST points elsewhere, e.g. WSL2→Windows)
    const wsPath = new URL(info.webSocketDebuggerUrl).pathname;
    return `ws://${host}:${port}${wsPath}`;
  }

  // DevToolsActivePort file discovery (Chrome, Edge, Brave, etc.)
  const home = homedir();
  // macOS: ~/Library/Application Support/<name>/DevToolsActivePort
  const macBrowsers = [
    'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome for Testing',
    'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge',
  ];
  // Linux: ~/.config/<name>/DevToolsActivePort
  const linuxBrowsers = [
    'google-chrome', 'google-chrome-beta', 'chromium',
    'vivaldi', 'vivaldi-snapshot',
    'BraveSoftware/Brave-Browser', 'microsoft-edge',
  ];
  // Windows: %LOCALAPPDATA%\<name>\User Data\DevToolsActivePort
  const winBrowsers = [
    'Google\\Chrome', 'Google\\Chrome Beta', 'Google\\Chrome for Testing',
    'Chromium', 'BraveSoftware\\Brave-Browser', 'Microsoft\\Edge',
  ];
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.CDP_PORT_FILE,
    ...winBrowsers.flatMap(b => [
      resolve(localAppData, b, 'User Data', 'DevToolsActivePort'),
      resolve(localAppData, b, 'User Data', 'Default', 'DevToolsActivePort'),
    ]),
    ...macBrowsers.flatMap(b => [
      resolve(home, 'Library/Application Support', b, 'DevToolsActivePort'),
      resolve(home, 'Library/Application Support', b, 'Default/DevToolsActivePort'),
    ]),
    ...linuxBrowsers.flatMap(b => [
      resolve(home, '.config', b, 'DevToolsActivePort'),
      resolve(home, '.config', b, 'Default/DevToolsActivePort'),
    ]),
    // Linux Flatpak: ~/.var/app/<app-id>/config/<name>/DevToolsActivePort
    ...([
      ['org.chromium.Chromium', 'chromium'],
      ['com.google.Chrome', 'google-chrome'],
      ['com.brave.Browser', 'BraveSoftware/Brave-Browser'],
      ['com.microsoft.Edge', 'microsoft-edge'],
      ['com.vivaldi.Vivaldi', 'vivaldi'],
    ]).flatMap(([appId, name]) => [
      resolve(home, '.var/app', appId, 'config', name, 'DevToolsActivePort'),
      resolve(home, '.var/app', appId, 'config', name, 'Default/DevToolsActivePort'),
    ]),
  ].filter(Boolean);
  const portFile = candidates.find(p => existsSync(p));
  if (!portFile) throw new Error('No DevToolsActivePort found and no CDP_PORT set.\n  Chrome: enable at chrome://inspect/#remote-debugging\n  Electron: set CDP_PORT=<port> (app must use --remote-debugging-port)');
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  if (lines.length < 2 || !lines[0] || !lines[1]) throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  return `ws://${host}:${lines[0]}${lines[1]}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseDelayMs(value, { name = 'ms', min = 1, max = 24 * 60 * 60 * 1000 } = {}) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer in milliseconds`);
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < min) throw new Error(`${name} must be at least ${min}ms`);
  if (ms > max) throw new Error(`${name} exceeds max ${max}ms`);
  return ms;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

function parseFormatArgs(args, allowed = ['text', 'json']) {
  const next = [];
  let format = 'text';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format') {
      const value = args[++i];
      if (!allowed.includes(value)) {
        throw new Error(`format must be ${allowed.join(' or ')}`);
      }
      format = value;
    } else {
      next.push(args[i]);
    }
  }
  return { format, args: next };
}

function parseCompactFormatArgs(args, allowed = ['text', 'json']) {
  const fopts = parseFormatArgs(args, allowed);
  let compact = false;
  let qa = false;
  let maxDiffLines = null;
  const next = [];
  for (let i = 0; i < fopts.args.length; i++) {
    const arg = fopts.args[i];
    if (arg === '--compact') compact = true;
    else if (arg === '--qa' || arg === '--summary') {
      qa = true;
      compact = true;
    } else if (arg === '--max-diff-lines') {
      maxDiffLines = parseNonNegativeInteger(fopts.args[++i], '--max-diff-lines');
    } else if (String(arg).startsWith('--max-diff-lines=')) {
      maxDiffLines = parseNonNegativeInteger(String(arg).slice('--max-diff-lines='.length), '--max-diff-lines');
    } else next.push(arg);
  }
  return { format: fopts.format, compact, qa, maxDiffLines, args: next };
}

function formatJson(model) {
  return JSON.stringify(model, null, 2);
}

function safeLstat(path) {
  try { return lstatSync(path); } catch { return null; }
}

function findNearestPackageJson(startDir = process.cwd()) {
  let dir = resolve(startDir || process.cwd());
  for (let i = 0; i < 12; i++) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

function readPackageVersion(packageJsonPath) {
  if (!packageJsonPath) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

function currentGitCommit(cwd) {
  try {
    const res = spawnSync('git', ['-C', cwd || process.cwd(), 'rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const commit = String(res.stdout || '').trim();
    return res.status === 0 && commit ? commit : null;
  } catch {
    return null;
  }
}

function collectDaemonMetadata({ scriptPath = process.argv[1], now = Date.now(), pid = process.pid } = {}) {
  const resolvedScriptPath = scriptPath ? resolve(scriptPath) : null;
  const scriptStats = resolvedScriptPath ? safeLstat(resolvedScriptPath) : null;
  const packageJsonPath = findNearestPackageJson(resolvedScriptPath ? dirname(resolvedScriptPath) : process.cwd());
  const gitCwd = packageJsonPath ? dirname(packageJsonPath) : process.cwd();
  return {
    schema: DAEMON_METADATA_SCHEMA,
    scriptPath: resolvedScriptPath,
    scriptMtimeMs: scriptStats ? scriptStats.mtimeMs : null,
    packageVersion: readPackageVersion(packageJsonPath),
    gitCommit: currentGitCommit(gitCwd),
    pid,
    startedAt: new Date(now).toISOString(),
  };
}

function comparableMetadataValue(value) {
  return value !== null && value !== undefined && value !== '' && value !== 'unknown';
}

function assessDaemonFreshness({ targetPrefix = '', current = null, daemon = null } = {}) {
  const displayTarget = targetPrefixForDisplay(targetPrefix);
  if (!daemon || daemon.schema !== DAEMON_METADATA_SCHEMA) {
    return {
      stale: true,
      status: 'missing-metadata',
      targetPrefix: displayTarget,
      current,
      daemon,
      mismatches: [{ field: 'metadata', daemon: null, current: 'available' }],
    };
  }

  const fields = ['gitCommit', 'packageVersion', 'scriptPath', 'scriptMtimeMs'];
  const mismatches = [];
  for (const field of fields) {
    const daemonValue = daemon[field];
    const currentValue = current?.[field];
    if (!comparableMetadataValue(daemonValue) || !comparableMetadataValue(currentValue)) continue;
    if (daemonValue !== currentValue) {
      mismatches.push({ field, daemon: daemonValue, current: currentValue });
    }
  }

  return {
    stale: mismatches.length > 0,
    status: mismatches.length > 0 ? 'stale' : 'current',
    targetPrefix: displayTarget,
    current,
    daemon,
    mismatches,
  };
}

function metadataCommit(metadata) {
  return metadata?.gitCommit || 'unknown';
}

function formatStaleDaemonMessage(assessment = {}) {
  const target = assessment.targetPrefix || '<target>';
  const currentCommit = metadataCommit(assessment.current);
  const stopCommand = `cdp stop ${target}`;
  if (assessment.status === 'missing-metadata') {
    return `Stale daemon for ${target}: daemon metadata missing, current commit ${currentCommit}. Run "${stopCommand}" then rerun the command. If this long-running daemon is intentional, rerun once with ${ALLOW_STALE_DAEMON_FLAG}.`;
  }

  const daemonCommit = metadataCommit(assessment.daemon);
  const pid = assessment.daemon?.pid ? `, pid ${assessment.daemon.pid}` : '';
  const mismatchText = Array.isArray(assessment.mismatches) && assessment.mismatches.length
    ? ` Mismatched metadata: ${assessment.mismatches.map(m => `${m.field} daemon=${m.daemon} current=${m.current}`).join(', ')}.`
    : '';
  return `Stale daemon for ${target}: daemon commit ${daemonCommit}, current commit ${currentCommit}${pid}.${mismatchText} Run "${stopCommand}" then rerun the command. If this long-running daemon is intentional, rerun once with ${ALLOW_STALE_DAEMON_FLAG}.`;
}

function parseDaemonMetadataResult(result) {
  if (!result) return null;
  if (typeof result === 'object') return result;
  try {
    return JSON.parse(String(result));
  } catch {
    return null;
  }
}

async function waitStr(msArg) {
  const ms = parseDelayMs(msArg, { name: 'wait duration', max: 60 * 60 * 1000 });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(Math.min(250, deadline - Date.now()));
  }
  return `Waited ${formatDuration(ms)}`;
}

function listDaemonSockets() {
  if (IS_WINDOWS) {
    // Named pipes aren't in filesystem; probe pipes for known targets from pages cache
    try {
      const cached = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
      return (Array.isArray(cached) ? cached : cached.pages || []).map(p => ({
        targetId: p.targetId,
        socketPath: sockPath(p.targetId),
      }));
    } catch { return []; }
  }
  try {
    return readdirSync(RUNTIME_DIR)
      .filter(f => f.startsWith('cdp-') && f.endsWith('.sock'))
      .map(f => ({
        targetId: f.slice(4, -5),
        socketPath: resolve(RUNTIME_DIR, f),
      }));
  } catch { return []; }
}

function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = [];

  async connect(wsUrl) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => res();
      this.#ws.onerror = (e) => rej(new Error('WebSocket error: ' + (e.message || e.type)));
      this.#ws.onclose = () => this.#closeHandlers.forEach(h => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId, timeoutMs = TIMEOUT) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      let timer;
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
      timer = setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() { this.#ws.close(); }
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  // Keep regular page targets, including about:blank so agents always have a
  // usable handle. Skip chrome://, edge://, and devtools:// internal pages.
  return targetInfos.filter(t => t.type === 'page'
    && !t.url.startsWith('chrome://')
    && !t.url.startsWith('edge://')
    && !t.url.startsWith('devtools://'));
}

function formatPageList(pages, browserInfo = null, opts = {}) {
  const aliases = opts.aliases || {};
  const ranked = opts.ranked === false ? pages : rankPageTargets(pages);
  const lines = [];
  if (browserInfo) {
    const ua = browserInfo['User-Agent'] || '';
    const m = ua.match(/Electron\/([\d.]+)/);
    if (m) lines.push(`[Electron ${m[1]}]`);
  }
  const prefixLen = getDisplayPrefixLength(ranked.map(p => p.targetId));
  const recommendedId = (rankPageTargets(pages).find(p => !isBlankPageUrl(p.url)) || ranked[0])?.targetId;
  lines.push(...ranked.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const isBlank = isBlankPageUrl(p.url);
    const rawTitle = isBlank ? '(blank tab)' : (p.title || '');
    const title = rawTitle.substring(0, 54).padEnd(54);
    const aliasNames = aliasesForTarget(p.targetId, aliases);
    const aliasSuffix = aliasNames.length ? `  ${aliasNames.map(name => `@${name}`).join(' ')}` : '';
    const rec = p.targetId === recommendedId ? ' *' : '';
    return `${id}  ${title}  ${p.url || ''}${aliasSuffix}${rec}`;
  }));
  return lines.join('\n');
}

function pageListBrowserModel(browserInfo = null) {
  if (!browserInfo) return null;
  const ua = browserInfo['User-Agent'] || '';
  const electron = ua.match(/Electron\/([\d.]+)/)?.[1] || null;
  return {
    product: browserInfo.Browser || browserInfo.product || null,
    userAgent: ua || null,
    electron,
  };
}

function buildPageListModel(pages = [], browserInfo = null, opts = {}) {
  const aliases = opts.aliases || {};
  const ranked = rankPageTargets(pages);
  const prefixLength = getDisplayPrefixLength(pages.map(p => p.targetId || ''));
  const modelPages = ranked.map((p, index) => {
    const isBlank = isBlankPageUrl(p.url);
    return {
      index: index + 1,
      targetId: p.targetId || '',
      targetPrefix: String(p.targetId || '').slice(0, prefixLength),
      type: p.type || 'page',
      title: isBlank ? '(blank tab)' : (p.title || ''),
      url: p.url || '',
      isBlank,
      score: pageTargetScore(p),
      recommended: false,
      aliases: aliasesForTarget(p.targetId || '', aliases),
    };
  });
  const recommendedPage = modelPages.find(page => !page.isBlank) || modelPages[0];
  if (recommendedPage) recommendedPage.recommended = true;
  const recommendation = recommendedPage
    ? goldenPathPerceiveRecommendation(recommendedPage.targetPrefix)
    : goldenPathOpenPageRecommendation();
  const nextSteps = recommendation.commands;
  return {
    schema: 'chrome-cdp-ex.list.v1',
    targetCount: modelPages.length,
    prefixLength,
    browser: pageListBrowserModel(browserInfo),
    pages: modelPages,
    recommended: recommendedPage
      ? {
          targetId: recommendedPage.targetId,
          targetPrefix: recommendedPage.targetPrefix,
          url: recommendedPage.url,
          title: recommendedPage.title,
          score: recommendedPage.score,
        }
      : null,
    aliases: Object.values(aliases).map(alias => ({ ...alias })),
    recommendation,
    nextSteps,
  };
}

function formatPageListOutput(pages, browserInfo = null, { format = 'text', aliases = {} } = {}) {
  if (format === 'json') return formatJson(buildPageListModel(pages, browserInfo, { aliases }));
  return formatPageList(pages, browserInfo, { aliases });
}

function shouldShowAxNode(node, compact = false, parentNode = null) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  // In compact mode, filter StaticText that duplicates parent's name
  if (compact && role === 'StaticText' && parentNode) {
    const parentName = parentNode.name?.value ?? '';
    if (parentName && parentName.includes(name)) return false;
  }
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

const PERCEIVE_PRIORITY_TEXT_RE = /\b(error|failed?|failure|invalid|required|warning|blocked|denied|unauthori[sz]ed|forbidden|saved|success|submitted|complete)\b/i;

function isPriorityPerceiveTextLine(line) {
  return PERCEIVE_PRIORITY_TEXT_RE.test(String(line || ''));
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth, parentNode = null) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact, parentNode)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1, node);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  lines.push('');
  lines.push('(Hint: `snap` gives only the raw AX tree. Use `perceive` instead for layout, @refs, style hints, and console health — it is the recommended starting command.)');
  return lines.join('\n');
}

// Decode a base64-encoded eval expression. Used by `eval64` and `eval --b64`
// so agents can ship CJK / Unicode / shell-hostile expressions without losing
// bytes to the surrounding shell quoting rules. We validate eagerly because a
// silently-corrupted expression would still compile and could match the wrong
// elements — better to surface a base64 error than to evaluate garbage.
function evalBase64Decode(b64) {
  if (b64 == null || b64 === '') {
    throw new Error('eval --b64: empty expression. Pass a base64-encoded JS expression.');
  }
  if (typeof b64 !== 'string') {
    throw new Error('eval --b64: expression must be a base64 string');
  }
  const cleaned = b64.replace(/\s+/g, '');
  // Charset check is intentionally loose on `=` so a misplaced pad falls
  // through to the dedicated padding check below with a clearer message.
  if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
    throw new Error('eval --b64: invalid base64 input (only A-Z, a-z, 0-9, +, /, = are allowed)');
  }
  // Standard base64 must be a multiple of 4 chars after padding, and `=`
  // padding may only appear at the very end. Node's Buffer base64 decoder is
  // intentionally lenient (it silently drops trailing junk), so without these
  // checks a corrupted or truncated payload would decode to a partial JS
  // expression and run as if it were the agent's intent.
  if (cleaned.length % 4 !== 0) {
    throw new Error(`eval --b64: invalid base64 length (${cleaned.length} chars; must be a multiple of 4 with = padding)`);
  }
  const padIdx = cleaned.indexOf('=');
  if (padIdx !== -1 && padIdx < cleaned.length - 2) {
    throw new Error('eval --b64: invalid base64 padding (= may only appear as the last 1-2 chars)');
  }
  if (padIdx === cleaned.length - 2 && cleaned[cleaned.length - 1] !== '=') {
    // e.g. "AB=Y" — first `=` at -2 but final char is not `=`; means body
    // starts after a single trailing pad, which is also illegal.
    throw new Error('eval --b64: invalid base64 padding (= may only appear as the last 1-2 chars)');
  }
  let decoded;
  try {
    decoded = Buffer.from(cleaned, 'base64').toString('utf8');
  } catch (e) {
    throw new Error(`eval --b64: cannot decode base64 (${e.message})`);
  }
  if (!decoded) {
    throw new Error('eval --b64: decoded expression is empty');
  }
  // Round-trip guard: re-encoding the decoded bytes must reproduce the
  // canonical input. This catches cases where the lenient Node decoder
  // accepted bytes it should not have (e.g. a tail char that does not align
  // to a 6-bit boundary), which would otherwise yield a silently-truncated
  // expression. We compare to the original `cleaned` form so legitimate
  // whitespace in the wire format is still tolerated.
  const reencoded = Buffer.from(decoded, 'utf8').toString('base64');
  if (reencoded !== cleaned) {
    throw new Error('eval --b64: input is not canonical base64 (decoder dropped bytes — payload may be truncated or corrupt)');
  }
  return decoded;
}

function runtimeExceptionMessage(exceptionDetails) {
  const text = exceptionDetails?.text;
  const description = exceptionDetails?.exception?.description;
  if (description && (text === 'Uncaught' || text === 'Uncaught (in promise)' || !text)) return description;
  return text || description || 'Unknown runtime exception';
}

function formatEvalValue(val, { raw = false } = {}) {
  // Preserve historical evalStr behavior: undefined prints as empty string.
  if (val === undefined) return '';
  if (val === null) return 'null';
  if (typeof val !== 'object') return String(val);
  // Default: pretty multi-line JSON for agents. --raw keeps a compact single-line encoding.
  return raw ? JSON.stringify(val) : JSON.stringify(val, null, 2);
}

function lastTopLevelSemicolon(source) {
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let depth = 0;
  let last = -1;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    else if (char === ';' && depth === 0) last = i;
  }
  return last;
}

function wrapAwaitExpression(expression, autoWrap = false) {
  const source = String(expression || '');
  if (!autoWrap || !/\bawait\b/.test(source)) return source;
  if (!source.includes(';') && !source.includes('\n')) return `(async()=>(${source}))()`;
  if (/\breturn\b/.test(source)) return `(async()=>{${source}})()`;

  const trimmed = source.replace(/;\s*$/, '').trimEnd();
  const separator = lastTopLevelSemicolon(trimmed);
  if (separator < 0) {
    throw new Error('eval: multi-statement async input is ambiguous; add an explicit return for the desired result.');
  }
  const prefix = trimmed.slice(0, separator + 1);
  const finalExpression = trimmed.slice(separator + 1).trim();
  if (!finalExpression) {
    throw new Error('eval: multi-statement async input is ambiguous; add an explicit return for the desired result.');
  }
  const wrapped = `(async()=>{${prefix} return (${finalExpression});})()`;
  try {
    // Syntax-check only; the returned function is never invoked here.
    new Function(`return ${wrapped}`); // eslint-disable-line no-new-func
  } catch {
    throw new Error('eval: cannot infer the final async expression safely; add an explicit return for the desired result.');
  }
  return wrapped;
}

async function evalStr(cdp, sid, expression, autoWrap = false, options = {}) {
  const expr = wrapAwaitExpression(expression, autoWrap);
  const params = {
    expression: expr, returnByValue: true, awaitPromise: true,
  };
  if (options.contextId != null) params.contextId = options.contextId;
  if (options.uniqueContextId != null) params.uniqueContextId = options.uniqueContextId;
  const result = await cdp.send('Runtime.evaluate', params, sid, options.timeoutMs);
  if (result.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  }
  const val = result.result.value;
  return formatEvalValue(val, { raw: options.raw === true });
}

function maybeAutoWrapEval(expression, autoWrap = false) {
  return wrapAwaitExpression(expression, autoWrap);
}

async function evalFireAndForgetStr(cdp, sid, expression, autoWrap = false) {
  if (!expression) throw new Error('Expression required');
  await cdp.send('Runtime.evaluate', {
    expression: maybeAutoWrapEval(expression, autoWrap),
    returnByValue: false,
    awaitPromise: false,
  }, sid);
  return 'Dispatched fire-and-forget eval (not awaiting returned promise)';
}

function formatCallResult(remote) {
  if (!remote) return '';
  if (Object.prototype.hasOwnProperty.call(remote, 'value')) {
    if (remote.value === undefined) return 'undefined';
    const json = JSON.stringify(remote.value, null, 2);
    return json === undefined ? String(remote.value) : json;
  }
  if (remote.unserializableValue != null) return String(remote.unserializableValue);
  return remote.description ?? '';
}

async function callStr(cdp, sid, expression) {
  if (!expression) throw new Error('Expression required');
  const wrapped = `(async () => {
    const value = (${expression});
    let result = (typeof value === 'function') ? value() : value;
    return await result;
  })()`;
  const result = await cdp.send('Runtime.evaluate', {
    expression: wrapped,
    returnByValue: true,
    awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  }
  return formatCallResult(result.result);
}

function parseEvalArgs(args) {
  const opts = { expression: '', fireAndForget: false, raw: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--fire-and-forget' || a === '--faf') opts.fireAndForget = true;
    else if (a === '--raw') opts.raw = true;
    else if (a === '--b64' || a === '-b') {
      const b64 = (args[++i] || '').trim();
      if (!b64) throw new Error('eval --b64: empty expression. Pass a base64-encoded JS expression.');
      opts.expression = evalBase64Decode(b64);
    } else {
      rest.push(a);
    }
  }
  if (!opts.expression) opts.expression = rest.join(' ');
  if (!opts.expression) throw new Error('Expression required');
  return opts;
}

function normalizeEvalCliArgs(args = []) {
  const fireAndForget = args.includes('--fire-and-forget') || args.includes('--faf');
  const raw = args.includes('--raw');
  const ignored = new Set(['--fire-and-forget', '--faf', '--raw']);
  const prefix = [
    ...(fireAndForget ? ['--fire-and-forget'] : []),
    ...(raw ? ['--raw'] : []),
  ];
  const b64Index = args.findIndex(arg => arg === '--b64' || arg === '-b');
  if (b64Index !== -1) {
    const b64 = args.slice(b64Index + 1)
      .filter(arg => !ignored.has(arg))
      .join('')
      .trim();
    if (!b64) throw new Error('base64 expression required');
    return [...prefix, '--b64', b64];
  }
  const expression = args.filter(arg => !ignored.has(arg)).join(' ').trim();
  if (!expression) throw new Error('expression required');
  return [...prefix, expression];
}

// ---------------------------------------------------------------------------
// emulate: media feature overrides (dark/light, reduced-motion, ...)
// ---------------------------------------------------------------------------

function emptyEmulateState() {
  return {
    schema: 'chrome-cdp-ex.emulate.v1',
    colorScheme: null,
    reducedMotion: null,
    features: [],
  };
}

function parseEmulateArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = {
    format: fopts.format,
    mode: 'status',
    colorScheme: null,
    reducedMotion: null,
  };
  const tokens = fopts.args;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === 'status' || token === 'show') opts.mode = 'status';
    else if (token === 'off' || token === 'reset' || token === 'clear') opts.mode = 'off';
    else if (token === 'dark' || token === 'light' || token === 'no-preference') {
      opts.mode = 'set';
      opts.colorScheme = token;
    } else if (token === 'color-scheme' || token === '--color-scheme') {
      const value = tokens[++i];
      if (!value || !['dark', 'light', 'no-preference'].includes(value)) {
        throw new Error('emulate: color-scheme requires dark|light|no-preference');
      }
      opts.mode = 'set';
      opts.colorScheme = value;
    } else if (token === 'reduced-motion' || token === '--reduced-motion') {
      const value = tokens[++i];
      if (!value || !['reduce', 'no-preference'].includes(value)) {
        throw new Error('emulate: reduced-motion requires reduce|no-preference');
      }
      opts.mode = 'set';
      opts.reducedMotion = value;
    } else if (token === 'reduce-motion') {
      opts.mode = 'set';
      opts.reducedMotion = 'reduce';
    } else {
      throw new Error(`emulate: unknown argument ${token}`);
    }
  }
  return opts;
}

function buildEmulateFeatures({ colorScheme = null, reducedMotion = null } = {}) {
  const features = [];
  if (colorScheme) features.push({ name: 'prefers-color-scheme', value: colorScheme });
  if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: reducedMotion });
  return features;
}

function buildEmulateModel(state = emptyEmulateState(), { targetPrefix = null, nextCommand = null } = {}) {
  const features = Array.isArray(state.features) ? state.features : buildEmulateFeatures(state);
  return {
    schema: 'chrome-cdp-ex.emulate.v1',
    targetPrefix,
    colorScheme: state.colorScheme || null,
    reducedMotion: state.reducedMotion || null,
    features,
    active: features.length > 0,
    nextCommand: nextCommand || (targetPrefix ? `cdp perceive ${targetPrefix} -C -d 8` : null),
  };
}

function formatEmulateText(model) {
  if (!model.active) {
    return [
      'Emulation: off (browser defaults)',
      model.nextCommand ? `Next: ${model.nextCommand}` : null,
    ].filter(Boolean).join('\n');
  }
  const lines = ['Emulation: active'];
  if (model.colorScheme) lines.push(`  prefers-color-scheme: ${model.colorScheme}`);
  if (model.reducedMotion) lines.push(`  prefers-reduced-motion: ${model.reducedMotion}`);
  if (model.nextCommand) lines.push(`Next: ${model.nextCommand}`);
  return lines.join('\n');
}

async function emulateStr(cdp, sid, session, args = [], { targetPrefix = null } = {}) {
  const opts = parseEmulateArgs(args);
  session.emulate = session.emulate || emptyEmulateState();
  if (opts.mode === 'off') {
    await cdp.send('Emulation.setEmulatedMedia', { features: [] }, sid);
    session.emulate = emptyEmulateState();
  } else if (opts.mode === 'set') {
    const next = {
      ...session.emulate,
      colorScheme: opts.colorScheme ?? session.emulate.colorScheme,
      reducedMotion: opts.reducedMotion ?? session.emulate.reducedMotion,
    };
    // Explicitly setting only one feature still replaces the whole media feature list.
    if (opts.colorScheme != null) next.colorScheme = opts.colorScheme;
    if (opts.reducedMotion != null) next.reducedMotion = opts.reducedMotion;
    next.features = buildEmulateFeatures(next);
    await cdp.send('Emulation.setEmulatedMedia', { features: next.features }, sid);
    session.emulate = next;
  }
  const model = buildEmulateModel(session.emulate, {
    targetPrefix,
    nextCommand: targetPrefix ? `cdp perceive ${targetPrefix} -C -d 8` : null,
  });
  return opts.format === 'json' ? formatJson(model) : formatEmulateText(model);
}

// ---------------------------------------------------------------------------
// Screenshot with multi-tier fallback (handles Electron CDP limitations)
// ---------------------------------------------------------------------------
// Tier 1: Page.captureScreenshot (standard)
// Tier 2: Page.captureScreenshot with fromSurface:false (view-based capture)
// Tier 3: Page.startScreencast single-frame grab (different rendering pipeline)
//
// Once a tier fails for a session, it is skipped on subsequent calls to avoid
// repeated 30s timeouts (critical for scanshot which captures multiple segments).
// State is per-module (one daemon = one tab session, so this is correct).
let _screenshotTier = 1; // start at tier 1; advances on failure
function resetScreenshotTier() { _screenshotTier = 1; }
function getScreenshotTier() { return _screenshotTier; }

async function screencastFallback(cdp, sid) {
  const frame = cdp.waitForEvent('Page.screencastFrame', SCREENSHOT_TIMEOUT);
  try {
    await cdp.send('Page.startScreencast', { format: 'png', quality: 100, everyNthFrame: 1 }, sid);
    const result = await frame.promise;
    // Acknowledge so the screencast doesn't stall
    cdp.send('Page.screencastFrameAck', { sessionId: result.sessionId }, sid).catch(() => {});
    return result.data;
  } finally {
    frame.cancel();
    cdp.send('Page.stopScreencast', {}, sid).catch(() => {});
  }
}

// Returns { data: base64string, fallback: boolean }.
// `params` is passed to Page.captureScreenshot (format, clip, etc.).
async function captureScreenshot(cdp, sid, params = { format: 'png' }) {
  // Tier 1: standard captureScreenshot
  if (_screenshotTier <= 1) {
    try {
      const result = await cdp.send('Page.captureScreenshot', params, sid, SCREENSHOT_TIMEOUT);
      return { data: result.data, fallback: false };
    } catch (err) {
      if (!err.message?.startsWith('Timeout:')) throw err;
      _screenshotTier = 2;
    }
  }

  // Tier 2: captureScreenshot with fromSurface:false (captures from view, not compositor)
  if (_screenshotTier <= 2) {
    try {
      const result = await cdp.send('Page.captureScreenshot',
        { ...params, fromSurface: false }, sid, SCREENSHOT_TIMEOUT);
      return { data: result.data, fallback: true };
    } catch (err) {
      if (!err.message?.startsWith('Timeout:')) throw err;
      _screenshotTier = 3;
    }
  }

  // Tier 3: screencast single-frame grab
  try {
    const data = await screencastFallback(cdp, sid);
    return { data, fallback: true };
  } catch {
    throw new Error(
      'Screenshot failed: all methods timed out (Page.captureScreenshot, fromSurface:false, screencast).\n' +
      'This Electron app may not support CDP screenshots. Use `perceive` for structural analysis instead.'
    );
  }
}

// Parse `shot` arguments. Returns { filePath, quiet, verbose }.
// Recognised flags: --quiet (only the saved path), --verbose (full DPR guidance).
// Default (no flags): saved path on the first line, then a brief DPR note —
// scripts that read `head -1` get a clean path without prelude noise.
function parseShotArgs(args) {
  const opts = { filePath: null, quiet: false, verbose: false };
  const tokens = (args || []).filter(a => a !== undefined && a !== null);
  for (const t of tokens) {
    if (t === '--quiet' || t === '-q') opts.quiet = true;
    else if (t === '--verbose' || t === '-v') opts.verbose = true;
    else if (typeof t === 'string' && !t.startsWith('--')) opts.filePath = t;
  }
  return opts;
}

async function shotStr(cdp, sid, filePathOrOpts, targetId, maybeOpts) {
  let filePath = null;
  let opts = { quiet: false, verbose: false };
  if (filePathOrOpts && typeof filePathOrOpts === 'object' && !Array.isArray(filePathOrOpts)) {
    filePath = filePathOrOpts.filePath || null;
    opts = { quiet: !!filePathOrOpts.quiet, verbose: !!filePathOrOpts.verbose };
  } else {
    filePath = filePathOrOpts || null;
    if (maybeOpts && typeof maybeOpts === 'object') {
      opts = { quiet: !!maybeOpts.quiet, verbose: !!maybeOpts.verbose };
    }
  }
  const dpr = await getDpr(cdp, sid);
  const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png' });
  const out = filePath || resolve(RUNTIME_DIR, `screenshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  // Default output: saved path FIRST so scripts grabbing `head -1` get a clean
  // path. Verbose adds full coordinate-mapping tutorial. Quiet hides hints.
  const lines = [out];
  if (fallback) lines.push(`(screenshot fallback — Page.captureScreenshot timed out)`);
  if (opts.quiet) return lines.join('\n');
  // Default: short DPR hint after the path. (`shot ... --verbose` for the long form.)
  lines.push(`Screenshot saved. DPR=${dpr}${dpr !== 1 ? ` (CSS px = image px / ${dpr})` : ''}`);
  if (opts.verbose) {
    lines.push(`Coordinate mapping:`);
    lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
    lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
    if (dpr !== 1) {
      lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
    }
  }
  return lines.join('\n');
}

function parseDiffShotArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = { format: fopts.format, thresholdRatio: 0, reset: false, keepBaseline: false };
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--reset') opts.reset = true;
    else if (token === '--keep-baseline') opts.keepBaseline = true;
    else if (token === '--threshold') {
      const raw = fopts.args[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error('diff-shot --threshold requires a non-negative percent value');
      opts.thresholdRatio = n / 100;
    } else {
      throw new Error(`diff-shot: unknown option ${token}`);
    }
  }
  return opts;
}

function formatPercentRatio(value) {
  const n = Number(value);
  return `${((Number.isFinite(n) ? n : 0) * 100).toFixed(2)}%`;
}

function diffShotCompareScript(baselinePngBase64, currentPngBase64) {
  return `
(async () => {
  const decode = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
  const load = async (b64) => {
    const blob = new Blob([decode(b64)], { type: 'image/png' });
    if (typeof createImageBitmap === 'function') return await createImageBitmap(blob);
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
      img.src = url;
    });
  };
  const [baseline, current] = await Promise.all([
    load(${JSON.stringify(baselinePngBase64)}),
    load(${JSON.stringify(currentPngBase64)}),
  ]);
  const width = Math.min(baseline.width, current.width);
  const height = Math.min(baseline.height, current.height);
  if (!width || !height) throw new Error('diff-shot: screenshot has empty dimensions');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(baseline, 0, 0, width, height);
  const baselineData = ctx.getImageData(0, 0, width, height);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(current, 0, 0, width, height);
  const currentData = ctx.getImageData(0, 0, width, height);
  const diffData = ctx.createImageData(width, height);
  let changedPixels = 0;
  for (let i = 0; i < baselineData.data.length; i += 4) {
    const dr = Math.abs(baselineData.data[i] - currentData.data[i]);
    const dg = Math.abs(baselineData.data[i + 1] - currentData.data[i + 1]);
    const db = Math.abs(baselineData.data[i + 2] - currentData.data[i + 2]);
    const da = Math.abs(baselineData.data[i + 3] - currentData.data[i + 3]);
    const changed = dr + dg + db + da > 0;
    if (changed) changedPixels++;
    if (changed) {
      diffData.data[i] = 255;
      diffData.data[i + 1] = 0;
      diffData.data[i + 2] = 180;
      diffData.data[i + 3] = 255;
    } else {
      const gray = Math.round((currentData.data[i] + currentData.data[i + 1] + currentData.data[i + 2]) / 3 * 0.35);
      diffData.data[i] = gray;
      diffData.data[i + 1] = gray;
      diffData.data[i + 2] = gray;
      diffData.data[i + 3] = 255;
    }
  }
  ctx.putImageData(diffData, 0, 0);
  const diffPngBase64 = canvas.toDataURL('image/png').split(',')[1] || '';
  const totalPixels = width * height;
  return JSON.stringify({
    width,
    height,
    baselineWidth: baseline.width,
    baselineHeight: baseline.height,
    currentWidth: current.width,
    currentHeight: current.height,
    changedPixels,
    totalPixels,
    changedRatio: totalPixels ? changedPixels / totalPixels : 0,
    diffPngBase64,
  });
})()
`;
}

function formatDiffShotResult(model = {}) {
  const lines = [];
  if (model.baselineCaptured) {
    lines.push(`Diff-shot baseline captured: ${model.baselinePath}`);
    if (model.fallback) lines.push('(screenshot fallback - Page.captureScreenshot timed out)');
    lines.push(`Next: cdp diff-shot ${model.targetId}`);
    lines.push('Pixel diff only: use perceive/cascade/report to explain semantic cause.');
    return lines.join('\n');
  }

  lines.push(`Diff-shot: changed ${model.changedPixels || 0}/${model.totalPixels || 0} px (${formatPercentRatio(model.changedRatio)})`);
  if (Number(model.thresholdRatio || 0) > 0) {
    lines.push(`Threshold: ${formatPercentRatio(model.thresholdRatio)} (${model.exceedsThreshold ? 'exceeded' : 'within threshold'})`);
  }
  lines.push(`Baseline: ${model.baselinePath}`);
  lines.push(`Current: ${model.currentPath}`);
  lines.push(`Diff image: ${model.diffPath}`);
  if (model.width && model.height) lines.push(`Compared: ${model.width}x${model.height} screenshot pixels`);
  if (model.fallback) lines.push('(screenshot fallback - Page.captureScreenshot timed out)');
  lines.push(model.advancedBaseline ? 'Baseline advanced to current capture.' : 'Baseline kept; pass without --keep-baseline to advance.');
  lines.push('Pixel diff only: use perceive/cascade/report to explain semantic cause.');
  return lines.join('\n');
}

function nextDiffShotArtifactPaths(session) {
  if (!session.diffShot) session.diffShot = {};
  const seq = Number(session.diffShot.seq || 0) + 1;
  session.diffShot.seq = seq;
  const dir = ensureSessionScreenshotDir(session) || session.screenshotDir || sessionScreenshotDir(session.targetId);
  const padded = String(seq).padStart(3, '0');
  return {
    baselinePath: resolve(dir, `diff-shot-baseline-${padded}.png`),
    currentPath: resolve(dir, `diff-shot-current-${padded}.png`),
    diffPath: resolve(dir, `diff-shot-diff-${padded}.png`),
  };
}

async function diffShotStr(cdp, sid, session, opts = {}) {
  const shot = await captureScreenshot(cdp, sid, { format: 'png' });
  const targetId = session.targetId;
  const reset = opts.reset || !session.diffShot?.baselineData;
  const paths = nextDiffShotArtifactPaths(session);
  if (reset) {
    writeFileSync(paths.baselinePath, Buffer.from(shot.data, 'base64'));
    session.diffShot = {
      ...(session.diffShot || {}),
      baselineData: shot.data,
      baselinePath: paths.baselinePath,
    };
    appendSessionScreenshot(session, { kind: 'diff-shot-baseline', path: paths.baselinePath, note: opts.reset ? 'reset baseline' : 'baseline' });
    const model = {
      schema: 'chrome-cdp-ex.diff-shot.v1',
      targetId,
      baselineCaptured: true,
      baselinePath: paths.baselinePath,
      currentPath: paths.baselinePath,
      diffPath: null,
      changedPixels: 0,
      totalPixels: 0,
      changedRatio: 0,
      thresholdRatio: opts.thresholdRatio || 0,
      exceedsThreshold: false,
      advancedBaseline: true,
      fallback: shot.fallback === true,
    };
    return opts.format === 'json' ? formatJson(model) : formatDiffShotResult(model);
  }

  writeFileSync(paths.currentPath, Buffer.from(shot.data, 'base64'));
  const compareRaw = await evalStr(cdp, sid, diffShotCompareScript(session.diffShot.baselineData, shot.data));
  const compare = JSON.parse(compareRaw);
  writeFileSync(paths.diffPath, Buffer.from(compare.diffPngBase64, 'base64'));
  appendSessionScreenshot(session, { kind: 'diff-shot-current', path: paths.currentPath, note: 'current capture' });
  appendSessionScreenshot(session, { kind: 'diff-shot-diff', path: paths.diffPath, note: 'pixel diff' });
  const priorBaselinePath = session.diffShot.baselinePath;
  const advancedBaseline = !opts.keepBaseline;
  if (advancedBaseline) {
    session.diffShot.baselineData = shot.data;
    session.diffShot.baselinePath = paths.currentPath;
  }
  const model = {
    schema: 'chrome-cdp-ex.diff-shot.v1',
    targetId,
    baselineCaptured: false,
    baselinePath: priorBaselinePath,
    currentPath: paths.currentPath,
    diffPath: paths.diffPath,
    width: compare.width,
    height: compare.height,
    baselineWidth: compare.baselineWidth,
    baselineHeight: compare.baselineHeight,
    currentWidth: compare.currentWidth,
    currentHeight: compare.currentHeight,
    changedPixels: compare.changedPixels,
    totalPixels: compare.totalPixels,
    changedRatio: compare.changedRatio,
    thresholdRatio: opts.thresholdRatio || 0,
    exceedsThreshold: compare.changedRatio > Number(opts.thresholdRatio || 0),
    advancedBaseline,
    fallback: shot.fallback === true,
  };
  return opts.format === 'json' ? formatJson(model) : formatDiffShotResult(model);
}

async function htmlStr(cdp, sid, selectorOrArgs) {
  // Share selector/root resolution rules with text where practical.
  let opts;
  if (Array.isArray(selectorOrArgs)) opts = parseTextArgs(selectorOrArgs);
  else if (typeof selectorOrArgs === 'string' || selectorOrArgs == null) {
    opts = parseTextArgs(selectorOrArgs ? [selectorOrArgs] : []);
  } else opts = { selectors: [], root: null };
  const selector = opts.selectors[0] || null;
  const root = opts.root || 'document';
  const result = await evalStr(cdp, sid, `(function() {
    function safeQuery(root, sel) { try { return root?.querySelector?.(sel) || null; } catch { return null; } }
    let scope = document.documentElement;
    const rootSetting = ${JSON.stringify(root)};
    if (rootSetting === 'body') scope = document.body || document.documentElement;
    else if (rootSetting === 'auto' || rootSetting === 'default') {
      scope = safeQuery(document, '#root') || safeQuery(document, '[data-reactroot]') || safeQuery(document, 'main') || document.body || document.documentElement;
    } else if (rootSetting !== 'document') {
      scope = safeQuery(document, rootSetting);
      if (!scope) return JSON.stringify({ ok: false, root: rootSetting, reason: 'root-not-found' });
    }
    if (!${JSON.stringify(selector)}) {
      return JSON.stringify({ ok: true, root: rootSetting, html: (scope || document.documentElement).outerHTML });
    }
    const el = scope === document || scope === document.documentElement
      ? safeQuery(document, ${JSON.stringify(selector)})
      : (scope.matches && scope.matches(${JSON.stringify(selector)}) ? scope : safeQuery(scope, ${JSON.stringify(selector)}));
    if (!el) return JSON.stringify({ ok: false, root: rootSetting, selector: ${JSON.stringify(selector)} });
    return JSON.stringify({ ok: true, root: rootSetting, html: el.outerHTML });
  })()`);
  let parsed;
  try { parsed = JSON.parse(result); } catch { return result; }
  if (!parsed.ok) {
    const rootLabel = parsed.root || root || 'document';
    const sel = parsed.selector || selector || '';
    throw new Error(
      `html: no element matched within root "${rootLabel}"${sel ? ` for selector ${sel}` : ''}. ` +
      `Fallback: cdp eval <target> "document.querySelector(${JSON.stringify(sel || 'selector')})?.outerHTML"`
    );
  }
  return parsed.html || '';
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState', false, { timeoutMs: options.probeTimeoutMs });
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sid, url) {
  validateUrl(url);
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

function formatMetricValue(name, value) {
  if (name === 'JSHeapUsedSize' || name === 'JSHeapTotalSize') {
    if (!Number.isFinite(value)) return String(value);
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

async function runtimeMetricsStr(cdp, sid) {
  try { await cdp.send('Performance.enable', {}, sid); } catch {}
  const { metrics = [] } = await cdp.send('Performance.getMetrics', {}, sid);
  const wanted = ['Documents', 'Frames', 'JSEventListeners', 'Nodes', 'JSHeapUsedSize', 'Tasks'];
  const byName = new Map(metrics.map(m => [m.name, m.value]));
  const lines = ['Runtime metrics (Performance.getMetrics):'];
  for (const name of wanted) {
    if (!byName.has(name)) continue;
    lines.push(`  ${name}: ${formatMetricValue(name, byName.get(name))}`);
  }
  if (lines.length === 1) lines.push('  (no requested metrics returned by this target)');
  return lines.join('\n');
}

function buildTargetStatusDiagnostic(err, { cmd = 'status', targetPrefix = '' } = {}) {
  const model = buildCliErrorModel(err, { cmd, targetPrefix });
  const state = model.recovery.kind === 'target-closed'
    ? 'closed'
    : model.recovery.kind === 'daemon-disconnect'
    ? 'daemon-disconnect'
    : 'error';
  return {
    state,
    error: model.error,
    recovery: model.recovery,
    nextSteps: model.nextSteps,
  };
}

async function pageInfoModel(cdp, sid, opts = {}) {
  let title = '', url = '';
  try {
    const info = JSON.parse(await evalStr(cdp, sid, 'JSON.stringify({ title: document.title, url: window.location.href })', false, { timeoutMs: STATUS_PAGE_INFO_TIMEOUT }));
    title = info.title;
    url = info.url;
  } catch (e) {
    return { title, url, diagnostic: buildTargetStatusDiagnostic(e, { targetPrefix: opts.targetPrefix }) };
  }
  return { title, url, diagnostic: null };
}

function parseConsoleArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  if (fopts.args.length > 1) {
    throw new Error('console: choose exactly one mode: --all, --errors, or --clear.');
  }
  const flag = fopts.args[0];
  const modes = new Map([
    [undefined, 'new'],
    ['--all', 'all'],
    ['--errors', 'errors'],
    ['--clear', 'clear'],
  ]);
  if (!modes.has(flag)) {
    throw new Error(`console: unknown option ${flag}. Supported options: --all, --errors, --clear, --format text|json.`);
  }
  return { mode: modes.get(flag), format: fopts.format };
}

function clearConsoleBaseline(consoleBuf, exceptionBuf, lastReadSeq) {
  const cleared = {
    console: consoleBuf.all().length,
    exceptions: exceptionBuf.all().length,
  };
  consoleBuf.clear();
  exceptionBuf.clear();
  lastReadSeq.console = consoleBuf.latest();
  lastReadSeq.exception = exceptionBuf.latest();
  return {
    schema: 'chrome-cdp-ex.console-baseline.v1',
    mode: 'clear',
    cleared,
    message: 'Console baseline cleared (console and exception buffers)',
  };
}

function buildConsoleModel(consoleBuf, exceptionBuf, lastReadSeq, flag) {
  const mode = flag === '--errors' ? 'errors' : flag === '--all' ? 'all' : flag || 'new';
  const showErrors = mode === 'errors';
  const showAll = mode === 'all';
  let entries;
  let exceptions = [];

  if (showAll) {
    entries = consoleBuf.all();
    exceptions = exceptionBuf.all();
  } else if (showErrors) {
    entries = consoleBuf.all().filter(e => e.level === 'error' || e.level === 'warning');
    exceptions = exceptionBuf.all();
  } else {
    entries = consoleBuf.since(lastReadSeq.console);
    exceptions = exceptionBuf.since(lastReadSeq.exception);
  }

  return {
    schema: 'chrome-cdp-ex.console.v1',
    mode: showAll ? 'all' : showErrors ? 'errors' : 'new',
    entries,
    exceptions,
  };
}

function buildStatusModel({ targetId, page, consoleBuf, exceptionBuf, navBuf, lastReadSeq, runtime = null, diagnostic = null }) {
  return {
    schema: 'chrome-cdp-ex.status.v1',
    targetId,
    target: {
      state: diagnostic?.state || 'connected',
      diagnostic,
    },
    page,
    console: consoleBuf.since(lastReadSeq.console),
    exceptions: exceptionBuf.since(lastReadSeq.exception),
    navigation: navBuf.since(lastReadSeq.nav || 0),
    runtime,
  };
}

async function statusStr(cdp, sid, consoleBuf, exceptionBuf, navBuf, lastReadSeq, opts = {}) {
  const { title, url, diagnostic } = await pageInfoModel(cdp, sid, { targetPrefix: opts.targetPrefix });

  const lines = [];
  lines.push(`URL: ${url}`);
  lines.push(`Title: ${title}`);
  if (diagnostic) {
    lines.push(`Target state: ${diagnostic.state}`);
    lines.push(`Diagnostic: ${diagnostic.error.message}`);
    lines.push(...formatCliErrorRecovery(diagnostic.recovery));
    lines.push(`Next: ${diagnostic.recovery.run}`);
  }

  const navs = navBuf.all();
  if (navs.length > 0) {
    const last = navs[navs.length - 1];
    const ago = Math.round((Date.now() - last.ts) / 1000);
    lines.push(`Navigations: ${navs.length} (last ${ago}s ago)`);
  }

  const newConsole = consoleBuf.since(lastReadSeq.console);
  const newExceptions = exceptionBuf.since(lastReadSeq.exception);

  if (newConsole.length > 0) {
    lines.push(`Console (${newConsole.length} new):`);
    for (const e of newConsole.slice(-20)) {
      const loc = e.loc ? ` (${e.loc})` : '';
      lines.push(`  [${e.level}] ${e.text.substring(0, 200)}${loc}`);
    }
    if (newConsole.length > 20) lines.push(`  ... and ${newConsole.length - 20} more (use 'console --all')`);
  } else {
    lines.push('Console: (no new entries)');
  }

  if (newExceptions.length > 0) {
    lines.push(`Exceptions (${newExceptions.length} new):`);
    for (const e of newExceptions.slice(-10)) {
      const loc = e.loc ? ` at ${e.loc}` : '';
      lines.push(`  ${e.msg.substring(0, 200)}${loc}`);
    }
  }

  if (opts.runtime) {
    try {
      lines.push(await runtimeMetricsStr(cdp, sid));
    } catch (e) {
      lines.push(`Runtime metrics (Performance.getMetrics): unavailable (${e.message})`);
    }
  }

  lastReadSeq.console = consoleBuf.latest();
  lastReadSeq.exception = exceptionBuf.latest();

  return lines.join('\n');
}

async function consoleStr(consoleBuf, exceptionBuf, lastReadSeq, flag) {
  let entries;
  let exceptions = [];
  const mode = flag === '--errors' ? 'errors' : flag === '--all' ? 'all' : flag || 'new';
  const showErrors = mode === 'errors';
  const showAll = mode === 'all';

  if (showAll) {
    entries = consoleBuf.all();
    exceptions = exceptionBuf.all();
  } else if (showErrors) {
    entries = consoleBuf.all().filter(e => e.level === 'error' || e.level === 'warning');
    exceptions = exceptionBuf.all();
  } else {
    entries = consoleBuf.since(lastReadSeq.console);
    exceptions = exceptionBuf.since(lastReadSeq.exception);
    lastReadSeq.console = consoleBuf.latest();
    lastReadSeq.exception = exceptionBuf.latest();
  }

  const lines = [];
  if (entries.length === 0 && exceptions.length === 0) {
    return showAll ? 'Console buffer is empty' : 'No new console entries';
  }

  for (const e of entries) {
    const loc = e.loc ? ` (${e.loc})` : '';
    lines.push(`[${e.level}] ${e.text.substring(0, 300)}${loc}`);
  }
  if (exceptions.length > 0) {
    lines.push('--- Uncaught Exceptions ---');
    for (const e of exceptions) {
      const loc = e.loc ? ` at ${e.loc}` : '';
      lines.push(`[exception] ${e.msg.substring(0, 300)}${loc}`);
    }
  }
  return lines.join('\n');
}

async function summaryModel(cdp, sid, consoleBuf, exceptionBuf) {
  const expr = `
    (function() {
      const counts = {};
      const interactive = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [tabindex]');
      let visibleControls = 0;
      for (const el of interactive) {
        const style = window.getComputedStyle(el);
        if (el.hidden || el.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
        visibleControls += 1;
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? 'input[' + (el.type || 'text') + ']' : tag;
        counts[type] = (counts[type] || 0) + 1;
      }
      const domNodes = document.querySelectorAll('*').length;
      let tableRows = 0;
      for (const table of document.querySelectorAll('table')) {
        const sourceRows = Number(table.getAttribute('data-source-rows') || table.dataset.sourceRows || 0);
        tableRows = Math.max(tableRows, table.querySelectorAll('tr').length, Number.isFinite(sourceRows) ? sourceRows : 0);
      }
      const hiddenTemplateNodes = document.querySelectorAll('template *, [data-hidden-template], [data-hidden-template] *, [hidden], [hidden] *, [aria-hidden="true"], [aria-hidden="true"] *').length;
      const focused = document.activeElement;
      const focusDesc = focused && focused !== document.body
        ? '<' + focused.tagName.toLowerCase() + (focused.id ? '#' + focused.id : '') + (focused.className ? '.' + focused.className.toString().split(' ')[0] : '') + '>'
        : 'none';
      return {
        title: document.title,
        url: window.location.href,
        viewport: window.innerWidth + 'x' + window.innerHeight,
        scrollY: Math.round(window.scrollY),
        scrollMax: Math.round(document.documentElement.scrollHeight - window.innerHeight),
        counts,
        domNodes,
        tableRows,
        visibleControls,
        hiddenTemplateNodes,
        focused: focusDesc,
      };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  const allConsole = consoleBuf.all();
  let errors = 0, warnings = 0;
  for (const e of allConsole) {
    if (e.level === 'error') errors++;
    else if (e.level === 'warning' || e.level === 'warn') warnings++;
  }
  const exceptions = exceptionBuf.all().length;

  return {
    schema: 'chrome-cdp-ex.summary.v1',
    page: { title: r.title, url: r.url },
    viewport: {
      size: r.viewport,
      scrollY: r.scrollY,
      scrollMax: r.scrollMax,
    },
    interactive: r.counts,
    counts: {
      domNodes: r.domNodes || 0,
      tableRows: r.tableRows || 0,
      visibleControls: r.visibleControls || 0,
      hiddenTemplateNodes: r.hiddenTemplateNodes || 0,
    },
    limits: {
      outputTokenBudget: 1200,
      hiddenTemplateNodesOmitted: r.hiddenTemplateNodes || 0,
      truncated: (r.domNodes || 0) > 1000 || (r.tableRows || 0) > 100 || (r.visibleControls || 0) > 50 || (r.hiddenTemplateNodes || 0) > 0,
    },
    focused: r.focused,
    console: { errors, warnings, exceptions },
  };
}

function formatSummaryText(model) {
  const lines = [];
  lines.push(`Title: ${model.page.title}`);
  lines.push(`URL: ${model.page.url}`);
  lines.push(`Viewport: ${model.viewport.size}`);

  const countParts = Object.entries(model.interactive).map(([k, v]) => `${v} ${k}`);
  lines.push(`Interactive: ${countParts.length > 0 ? countParts.join(', ') : 'none found'}`);

  lines.push(`Focused: ${model.focused}`);

  if (model.viewport.scrollMax > 0) {
    const pct = Math.round(model.viewport.scrollY / model.viewport.scrollMax * 100);
    lines.push(`Scroll: ${model.viewport.scrollY} / ${model.viewport.scrollMax} max (${pct}%)`);
  } else {
    lines.push('Scroll: no scroll');
  }

  const parts = [];
  if (model.console.errors > 0) parts.push(`${model.console.errors} error${model.console.errors > 1 ? 's' : ''}`);
  if (model.console.warnings > 0) parts.push(`${model.console.warnings} warning${model.console.warnings > 1 ? 's' : ''}`);
  if (model.console.exceptions > 0) parts.push(`${model.console.exceptions} exception${model.console.exceptions > 1 ? 's' : ''}`);
  lines.push(`Console: ${parts.length > 0 ? parts.join(', ') : 'clean'}`);

  return lines.join('\n');
}

async function summaryStr(cdp, sid, consoleBuf, exceptionBuf) {
  return formatSummaryText(await summaryModel(cdp, sid, consoleBuf, exceptionBuf));
}

const MAX_ACTION_DELTA_ENTRIES = 5;
const MAX_ACTION_JSON_DOM_DIFF_CHARS = 800;
const DEFAULT_REPORT_ACTION_LIMIT = 20;
const DEFAULT_REPORT_JSON_BYTES_MAX = 64 * 1024;
const DEFAULT_STALE_ARTIFACT_HOURS = 24;
const REDACTED_VALUE = '<redacted>';
const SENSITIVE_QUERY_KEY_RE = /\b(pass(word)?|secret|token|api[-_]?key|credential|otp|2fa|mfa|auth(orization)?|pin|cvv|card|ssn|session|sid|cookie|jwt|csrf|xsrf|refresh|access)\b/i;
const SENSITIVE_METADATA_KEY_ALLOWLIST = new Set([
  'schema',
  'source',
  'targetId',
  'targetPrefix',
  'sessionId',
  'sessionStorage',
  'localStorage',
  'storage',
  'cookies',
  'cookieCount',
  'createdAt',
  'now',
  'ts',
  'index',
  'action',
  'kind',
  'status',
  'method',
  'path',
  'paths',
  'url',
  'origin',
  'title',
  'domain',
  'sameSite',
  'secure',
  'httpOnly',
  'expires',
  'redaction',
  'redacted',
]);
const SECRET_ASSIGNMENT_RE = /(^|[\s{[,;?&])([A-Za-z0-9_.-]*(?:pass(?:word)?|secret|token|api[-_]?key|credential|otp|2fa|mfa|auth(?:orization)?|pin|cvv|card|ssn|session|sid|cookie|jwt|csrf|xsrf|refresh|access)[A-Za-z0-9_.-]*\s*[:=]\s*)(["']?)([^"'\s,;&}\])]+)/gi;
const AUTH_HEADER_VALUE_RE = /\b(Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]+)/gi;
const BEARER_VALUE_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi;
const NOISY_ACTION_NETWORK_TYPES = new Set(['Image', 'Stylesheet', 'Script', 'Font', 'Media', 'WebSocket']);

function isSensitiveDataKey(key = '') {
  const name = String(key || '');
  if (!name || SENSITIVE_METADATA_KEY_ALLOWLIST.has(name)) return false;
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ');
  return SENSITIVE_QUERY_KEY_RE.test(name) || SENSITIVE_QUERY_KEY_RE.test(normalized);
}

function redactSensitiveString(value) {
  const text = String(value ?? '');
  return text
    .replace(AUTH_HEADER_VALUE_RE, `$1${REDACTED_VALUE}`)
    .replace(BEARER_VALUE_RE, `$1${REDACTED_VALUE}`)
    .replace(SECRET_ASSIGNMENT_RE, (_match, prefix, key, quote) => `${prefix}${key}${quote}${REDACTED_VALUE}${quote}`);
}

function redactSensitiveArtifactValue(value, key = '') {
  if (value == null) return value;
  if (isSensitiveDataKey(key)) return REDACTED_VALUE;
  if (typeof value === 'string') return redactSensitiveString(value);
  if (Array.isArray(value)) return value.map(item => redactSensitiveArtifactValue(item));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactSensitiveArtifactValue(entryValue, entryKey),
    ]));
  }
  return value;
}

function createActionResult({ action, target, dispatch, settle, effects, nextHint }) {
  return applyActionReceipt(applyActionVerdict(applyActionRecommendation(applyActionOutcome(applyActionDiagnosis({
    schema: 'chrome-cdp-ex.action.v1',
    action,
    target,
    dispatch,
    settle,
    effects,
    nextHint,
  })))));
}

function createActionObservationBaseline({ consoleBuf = null, exceptionBuf = null, netReqBuf = null } = {}) {
  return {
    console: typeof consoleBuf?.latest === 'function' ? consoleBuf.latest() : 0,
    exception: typeof exceptionBuf?.latest === 'function' ? exceptionBuf.latest() : 0,
    network: typeof netReqBuf?.latest === 'function' ? netReqBuf.latest() : 0,
  };
}

function compactActionText(value, max = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function compactActionUrl(value) {
  const raw = compactActionText(value, 240);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const params = new URLSearchParams(url.search);
    for (const key of [...params.keys()]) {
      if (SENSITIVE_QUERY_KEY_RE.test(key)) params.set(key, '<redacted>');
    }
    const query = params.toString();
    return compactActionText(`${url.pathname}${query ? `?${query}` : ''}${url.hash || ''}`, 180);
  } catch {
    return compactActionText(raw, 180);
  }
}

function compactObservationError(err) {
  const message = compactActionText(redactSensitiveString(actionFailureMessage(err)), 240);
  return {
    name: compactActionText(err?.name || err?.constructor?.name || 'Error', 80),
    message: message || 'Post-action observation failed.',
  };
}

function compactConsoleDeltaEntry(entry = {}) {
  return {
    level: compactActionText(entry.level || 'log', 30),
    text: compactActionText(redactSensitiveString(entry.text || entry.msg || entry.message || '')),
    loc: compactActionText(entry.loc || '', 120),
  };
}

function compactExceptionDeltaEntry(entry = {}) {
  return {
    message: compactActionText(redactSensitiveString(entry.msg || entry.message || entry.text || 'Unknown exception')),
    loc: compactActionText(entry.loc || '', 120),
  };
}

function isNetworkFailure(entry = {}) {
  if (entry.failed === true || entry.errorText) return true;
  const status = Number(entry.status);
  return Number.isFinite(status) && status >= 400;
}

function shouldTrackActionNetworkRequest(type) {
  return !NOISY_ACTION_NETWORK_TYPES.has(String(type || ''));
}

function compactNetworkDeltaEntry(entry = {}) {
  const status = entry.pending ? 'pending' : (entry.errorText ? 'failed' : entry.status);
  return {
    method: compactActionText(entry.method || 'GET', 20).toUpperCase(),
    url: compactActionUrl(entry.url || ''),
    status,
    type: compactActionText(entry.type || '', 40),
    duration: Number.isFinite(entry.duration) ? entry.duration : null,
    errorText: entry.errorText ? compactActionText(entry.errorText, 120) : null,
    pending: entry.pending === true,
  };
}

function buildActionObservationDelta({ consoleBuf = null, exceptionBuf = null, netReqBuf = null } = {}, baseline = {}) {
  const consoleEntries = typeof consoleBuf?.since === 'function' ? consoleBuf.since(baseline.console || 0) : [];
  const exceptionEntries = typeof exceptionBuf?.since === 'function' ? exceptionBuf.since(baseline.exception || 0) : [];
  const networkEntries = typeof netReqBuf?.since === 'function' ? netReqBuf.since(baseline.network || 0) : [];
  const consoleCompact = consoleEntries.slice(-MAX_ACTION_DELTA_ENTRIES).map(compactConsoleDeltaEntry);
  const exceptionCompact = exceptionEntries.slice(-MAX_ACTION_DELTA_ENTRIES).map(compactExceptionDeltaEntry);
  const networkCompact = networkEntries.slice(-MAX_ACTION_DELTA_ENTRIES).map(compactNetworkDeltaEntry);
  return {
    console: {
      count: consoleEntries.length,
      errors: consoleEntries.filter(entry => ['error', 'assert'].includes(String(entry.level || '').toLowerCase())).length,
      warnings: consoleEntries.filter(entry => ['warning', 'warn'].includes(String(entry.level || '').toLowerCase())).length,
      entries: consoleCompact,
    },
    exceptions: {
      count: exceptionEntries.length,
      entries: exceptionCompact,
    },
    network: {
      count: networkEntries.length,
      failures: networkEntries.filter(isNetworkFailure).length,
      pending: networkEntries.filter(entry => entry.pending === true).length,
      entries: networkCompact,
    },
  };
}

function numericDeltaCount(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeConsoleDelta(delta = {}) {
  const entries = (delta.entries || []).slice(-MAX_ACTION_DELTA_ENTRIES).map(compactConsoleDeltaEntry);
  return {
    count: numericDeltaCount(delta.count, entries.length),
    errors: numericDeltaCount(delta.errors, entries.filter(entry => ['error', 'assert'].includes(String(entry.level || '').toLowerCase())).length),
    warnings: numericDeltaCount(delta.warnings, entries.filter(entry => ['warning', 'warn'].includes(String(entry.level || '').toLowerCase())).length),
    entries,
  };
}

function normalizeExceptionDelta(delta = {}) {
  const entries = (delta.entries || []).slice(-MAX_ACTION_DELTA_ENTRIES).map(compactExceptionDeltaEntry);
  return {
    count: numericDeltaCount(delta.count, entries.length),
    entries,
  };
}

function normalizeNetworkDelta(delta = {}) {
  const entries = (delta.entries || []).slice(-MAX_ACTION_DELTA_ENTRIES).map(compactNetworkDeltaEntry);
  return {
    count: numericDeltaCount(delta.count, entries.length),
    failures: numericDeltaCount(delta.failures, entries.filter(isNetworkFailure).length),
    pending: numericDeltaCount(delta.pending, entries.filter(entry => entry.pending === true).length),
    entries,
  };
}

function actionDomDiffShowsChange(domDiff) {
  const text = String(domDiff || '').trim();
  if (!text) return false;
  return !/no changes detected/i.test(text);
}

function actionHasDomObservation(actionResult = {}) {
  return Object.prototype.hasOwnProperty.call(actionResult.effects || {}, 'domDiff')
    && actionResult.effects.domDiff !== null
    && actionResult.effects.domDiff !== undefined;
}

function buildActionOutcome(actionResult = {}) {
  const effects = actionResult.effects || {};
  const diagnosis = effects.diagnosis || null;
  const domObserved = actionHasDomObservation(actionResult);
  const changed = actionDomDiffShowsChange(effects.domDiff);
  const base = {
    schema: 'chrome-cdp-ex.action-outcome.v1',
    changed: domObserved ? changed : null,
    needsAttention: false,
  };

  if (actionResult.dispatch?.ok === false || effects.failure?.kind) {
    return {
      ...base,
      status: 'failed',
      changed: false,
      needsAttention: true,
      evidence: 'dispatch',
      reason: effects.failure?.reason || 'Action failed before dispatch completed.',
    };
  }

  if (diagnosis?.kind === 'observation-error' || effects.observationError?.message) {
    return {
      ...base,
      status: 'attention',
      needsAttention: true,
      evidence: 'observation',
      reason: diagnosis.reason || 'Action dispatched, but post-action observation failed.',
    };
  }

  if (actionResult.dispatch?.ok === true && actionResult.settle?.ok === false) {
    return {
      ...base,
      status: 'timeout',
      needsAttention: true,
      evidence: 'settle',
      reason: 'Action dispatched, but post-action observation timed out.',
    };
  }

  if (diagnosis && diagnosis.status !== 'ok') {
    return {
      ...base,
      status: 'attention',
      needsAttention: true,
      evidence: diagnosis.source || 'diagnosis',
      reason: diagnosis.reason || 'Action needs follow-up.',
    };
  }

  if (changed) {
    return {
      ...base,
      status: 'changed',
      changed: true,
      evidence: 'dom',
      reason: 'Observed page change after action.',
    };
  }

  if (domObserved) {
    return {
      ...base,
      status: 'no-change',
      changed: false,
      needsAttention: true,
      evidence: 'dom',
      reason: 'No visible AX tree change observed after action.',
    };
  }

  return {
    ...base,
    status: 'dispatched',
    evidence: 'dispatch',
    reason: 'Action dispatched; no DOM observation was captured for this command.',
  };
}

function applyActionOutcome(actionResult) {
  actionResult.outcome = buildActionOutcome(actionResult);
  return actionResult;
}

function stableActionHash(value = {}) {
  const text = JSON.stringify(value, Object.keys(value || {}).sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function buildActionId(actionResult = {}) {
  const seed = {
    action: actionResult.action || '',
    target: actionResult.target?.label || actionResult.target?.input || '',
    dispatch: actionResult.dispatch?.method || '',
    settle: actionResult.settle?.durationMs || 0,
    outcome: actionResult.outcome?.status || '',
  };
  const first = stableActionHash(seed);
  const second = stableActionHash({ ...seed, dispatchOk: actionResult.dispatch?.ok === true });
  return `act_${first}${second.slice(0, 4)}`;
}

function actionTargetSummary(actionResult = {}) {
  const target = actionResult.target || {};
  return compactActionText(target.label || target.input || target.selector || target.resolvedBy || actionResult.action || '', 160) || null;
}

function actionSettlementStrategy(actionResult = {}) {
  if (actionResult.dispatch?.ok === false) return 'dispatch-failed';
  if (actionResult.effects?.failure?.kind) return 'dispatch-failed';
  if (actionResult.effects?.observationError?.message) return 'observation-error';
  if (actionResult.settle?.ok === false) return 'timeout';
  if (actionResult.effects?.domDiff != null) return 'dom-observation';
  return 'report-only';
}

function actionSettlementObservedChannels(actionResult = {}) {
  const effects = actionResult.effects || {};
  const channels = [];
  if (actionResult.dispatch?.ok === false || effects.failure?.kind) channels.push('dispatch');
  if (effects.domDiff != null) channels.push('ax-diff');
  if (Object.hasOwn(effects, 'consoleDelta')) channels.push('console');
  if (Object.hasOwn(effects, 'exceptionDelta')) channels.push('exceptions');
  if (Object.hasOwn(effects, 'networkDelta')) channels.push('network');
  if (effects.observationError?.message) channels.push('observation');
  return [...new Set(channels)];
}

function actionSettlementSignals(actionResult = {}, strategy = actionSettlementStrategy(actionResult)) {
  if (strategy === 'dispatch-failed') return ['dispatch-failed'];
  if (strategy === 'observation-error') return ['observation-error'];
  if (strategy === 'timeout') return ['settlement-timeout'];
  if (strategy === 'report-only') return ['report-only'];
  return [];
}

function actionSettlementState(actionResult = {}, strategy = actionSettlementStrategy(actionResult)) {
  if (strategy === 'dispatch-failed') return 'failed';
  if (strategy === 'report-only') return 'not-applicable';
  if (actionResult.settle?.ok === true) return 'settled';
  return 'not-confirmed';
}

function actionSettlementReason(actionResult = {}, strategy = actionSettlementStrategy(actionResult)) {
  if (strategy === 'dispatch-failed') return 'Action failed before dispatch completed.';
  if (strategy === 'observation-error') return 'Action dispatched, but post-action observation failed.';
  if (strategy === 'timeout') return 'Action dispatched, but post-action observation did not confirm settlement.';
  if (strategy === 'report-only') return 'Action dispatched without post-action DOM observation.';
  if (strategy === 'dom-observation') return 'Post-action DOM observation completed.';
  return 'Action settlement status is not confirmed.';
}

function buildSettlementReceipt(actionResult = {}) {
  const strategy = actionSettlementStrategy(actionResult);
  return {
    ok: actionResult.settle?.ok ?? null,
    state: actionSettlementState(actionResult, strategy),
    strategy,
    durationMs: Number.isFinite(actionResult.settle?.durationMs) ? actionResult.settle.durationMs : null,
    timeoutMs: Number.isFinite(actionResult.settle?.timeoutMs) ? actionResult.settle.timeoutMs : null,
    observedChannels: actionSettlementObservedChannels(actionResult),
    signals: actionSettlementSignals(actionResult, strategy),
    reason: actionSettlementReason(actionResult, strategy),
  };
}

function actionDeltaDetails(actionResult = {}) {
  const effects = actionResult.effects || {};
  const details = [];
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);

  if (effects.failure?.kind) {
    details.push({
      type: 'dispatch',
      status: 'failed',
      summary: `Dispatch failed: ${effects.failure.kind}`,
      ...(effects.failure.reason ? { sample: effects.failure.reason } : {}),
    });
  } else if (outcome.status === 'changed') {
    const sample = summarizeActionDomDiff(effects.domDiff).sample;
    details.push({
      type: 'dom',
      status: 'changed',
      summary: 'DOM changed after action',
      ...(sample ? { sample } : {}),
    });
  } else if (outcome.status === 'no-change') {
    details.push({
      type: 'dom',
      status: 'no-change',
      summary: 'No visible AX tree change observed',
    });
  } else if (effects.domDiff == null) {
    details.push({
      type: 'dom',
      status: 'not-captured',
      summary: 'DOM observation not captured',
    });
  }

  const consoleDelta = normalizeConsoleDelta(effects.consoleDelta || {});
  const consoleSummary = summarizeActionConsoleDelta(consoleDelta);
  details.push({
    type: 'console',
    status: consoleDelta.count > 0 ? 'changed' : 'unchanged',
    count: Number(consoleDelta.count || 0),
    errors: Number(consoleDelta.errors || 0),
    warnings: Number(consoleDelta.warnings || 0),
    summary: consoleSummary.summary || 'Console unchanged',
    ...(consoleSummary.sample ? { sample: consoleSummary.sample } : {}),
  });

  const exceptionDelta = normalizeExceptionDelta(effects.exceptionDelta || {});
  const exceptionSummary = summarizeActionExceptionDelta(exceptionDelta);
  details.push({
    type: 'exception',
    status: exceptionDelta.count > 0 ? 'changed' : 'unchanged',
    count: Number(exceptionDelta.count || 0),
    summary: exceptionSummary.summary || 'Exceptions unchanged',
    ...(exceptionSummary.sample ? { sample: exceptionSummary.sample } : {}),
  });

  const networkDelta = normalizeNetworkDelta(effects.networkDelta || {});
  const networkSummary = summarizeActionNetworkDelta(networkDelta);
  details.push({
    type: 'network',
    status: networkDelta.count > 0 ? 'changed' : 'unchanged',
    count: Number(networkDelta.count || 0),
    failures: Number(networkDelta.failures || 0),
    pending: Number(networkDelta.pending || 0),
    summary: networkSummary.summary || 'Network unchanged',
    ...(networkSummary.sample ? { sample: networkSummary.sample } : {}),
  });

  if (effects.observationError?.message) {
    details.push({
      type: 'observation',
      status: 'error',
      summary: `Observation error: ${effects.observationError.message}`,
    });
  }
  return details;
}

function actionDeltaLines(actionResult = {}) {
  const lines = [];
  for (const detail of actionDeltaDetails(actionResult)) {
    if (detail.summary) lines.push(detail.summary);
    if (!detail.sample) continue;
    if (detail.type === 'dom') lines.push(`DOM sample: ${detail.sample}`);
    else if (detail.type === 'console') lines.push(`Console sample: ${detail.sample}`);
    else if (detail.type === 'exception') lines.push(`Exception sample: ${detail.sample}`);
    else if (detail.type === 'network') lines.push(`Network sample: ${detail.sample}`);
  }
  return lines;
}

function actionBlockingSignals(actionResult = {}) {
  const signals = [];
  const diagnosis = actionResult.effects?.diagnosis || null;
  const recommendation = actionResult.recommendation || {};
  if (Array.isArray(recommendation.blockingSignals)) signals.push(...recommendation.blockingSignals);
  if (diagnosis?.kind && diagnosis.status !== 'ok') signals.push(diagnosis.kind);
  if (actionResult.outcome?.status === 'timeout') signals.push('settlement-timeout');
  if (actionResult.effects?.observationError?.message) signals.push('observation-error');
  return [...new Set(signals)];
}

function actionRecoveryHint(actionResult = {}) {
  const recommendation = actionResult.recommendation || {};
  const diagnosis = actionResult.effects?.diagnosis || null;
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);
  if (typeof recommendation.recoveryHint === 'string' && recommendation.recoveryHint.trim()) return recommendation.recoveryHint;
  if (diagnosis?.reason && diagnosis.status !== 'ok') return diagnosis.reason;
  if (outcome.status === 'changed') return 'Continue from the observed action evidence.';
  if (outcome.status === 'failed') return 'Run the recovery command before retrying the action.';
  if (outcome.status === 'timeout') return 'Verify the post-action state before retrying; the action may have dispatched.';
  if (outcome.status === 'dispatched') return 'Capture a fresh observation before assuming task progress.';
  return recommendation.reason || outcome.reason || actionResult.nextHint || null;
}

function buildActionReceipt(actionResult = {}) {
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);
  const recommendation = actionResult.recommendation || {};
  const nextSteps = uniqueNextStepCommands(actionResult.nextSteps || recommendation.commands || []);
  return {
    schema: 'chrome-cdp-ex.action-receipt.v1',
    actionId: buildActionId(actionResult),
    actionName: actionResult.action || null,
    targetSummary: actionTargetSummary(actionResult),
    dispatch: actionResult.dispatch || null,
    settlement: buildSettlementReceipt(actionResult),
    outcome: outcome.status || 'unknown',
    observedDelta: actionDeltaLines(actionResult),
    observedDeltaDetails: actionDeltaDetails(actionResult),
    blockingSignals: actionBlockingSignals(actionResult),
    recoveryHint: actionRecoveryHint(actionResult),
    nextSteps,
    recovery: {
      strategy: recommendation.strategy || actionResult.effects?.diagnosis?.recovery?.strategy || null,
      priority: recommendation.priority || actionResult.effects?.diagnosis?.recovery?.priority || null,
      verifyCommand: recommendation.verifyCommand || actionResult.effects?.diagnosis?.recovery?.verifyCommand || null,
    },
  };
}

function applyActionReceipt(actionResult) {
  actionResult.receipt = buildActionReceipt(actionResult);
  return actionResult;
}

function applyActionObservationDelta(actionResult, delta = {}) {
  if (!actionResult.effects) actionResult.effects = {};
  const consoleDelta = normalizeConsoleDelta(delta.console || {});
  const exceptionDelta = normalizeExceptionDelta(delta.exceptions || {});
  const networkDelta = normalizeNetworkDelta(delta.network || {});
  actionResult.effects.consoleDelta = consoleDelta;
  actionResult.effects.exceptionDelta = exceptionDelta;
  actionResult.effects.networkDelta = networkDelta;
  actionResult.effects.console = consoleDelta.entries || [];
  actionResult.effects.exceptions = exceptionDelta.entries || [];
  actionResult.effects.network = networkDelta.entries || [];
  return applyActionReceipt(applyActionVerdict(applyActionRecommendation(applyActionOutcome(applyActionDiagnosis(actionResult)))));
}

function actionDiagnosisSignals(actionResult = {}) {
  const effects = actionResult.effects || {};
  const consoleDelta = normalizeConsoleDelta(effects.consoleDelta || {});
  const exceptionDelta = normalizeExceptionDelta(effects.exceptionDelta || {});
  const networkDelta = normalizeNetworkDelta(effects.networkDelta || {});
  return {
    dispatchOk: actionResult.dispatch?.ok !== false,
    settleOk: actionResult.settle?.ok ?? null,
    domChanged: actionDomDiffShowsChange(effects.domDiff),
    consoleErrors: consoleDelta.errors,
    consoleWarnings: consoleDelta.warnings,
    exceptions: exceptionDelta.count,
    networkFailures: networkDelta.failures,
    networkPending: networkDelta.pending,
    observationError: Boolean(effects.observationError?.message),
  };
}

function createActionDiagnosis(actionResult = {}) {
  const effects = actionResult.effects || {};
  const targetId = actionTargetCommandId(actionResult.target || {});
  const targetInput = actionFailureInput(actionResult.target || effects.failure?.target || {});
  const signals = actionDiagnosisSignals(actionResult);
  const finish = (diagnosis) => ({
    ...diagnosis,
    recovery: buildActionRecoveryPlan(diagnosis, { targetId, targetInput }),
  });
  const base = {
    schema: 'chrome-cdp-ex.action-diagnosis.v1',
    status: 'ok',
    kind: 'ok',
    confidence: 'medium',
    source: 'action',
    reason: 'Action dispatched without captured runtime failures.',
    nextCommand: actionResult.nextHint || null,
    signals,
  };

  if (effects.failure?.kind) {
    return finish({
      ...base,
      status: 'blocked',
      kind: effects.failure.kind,
      confidence: 'high',
      source: 'dispatch',
      reason: effects.failure.reason || 'The action failed before dispatch completed.',
      nextCommand: effects.failure.nextCommand || actionResult.nextHint || `cdp status ${targetId}`,
    });
  }

  if (signals.observationError) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'observation-error',
      confidence: 'medium',
      source: 'observation',
      reason: `The action was dispatched, but post-action observation failed: ${effects.observationError.message}`,
      nextCommand: `cdp status ${targetId}`,
    });
  }

  if (signals.exceptions > 0) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'exception',
      confidence: 'high',
      source: 'exception',
      reason: 'The action triggered one or more page exceptions.',
      nextCommand: `cdp console ${targetId} --errors`,
    });
  }

  if (signals.networkFailures > 0) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'network-failure',
      confidence: 'high',
      source: 'network',
      reason: 'The action triggered one or more failed network requests.',
      nextCommand: `cdp netlog ${targetId}`,
    });
  }

  if (signals.networkPending > 0) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'network-pending',
      confidence: 'medium',
      source: 'network',
      reason: 'The action left network requests pending after the settle window.',
      nextCommand: `cdp netlog ${targetId}`,
    });
  }

  if (signals.consoleErrors > 0) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'console-error',
      confidence: 'high',
      source: 'console',
      reason: 'The action triggered one or more console errors.',
      nextCommand: `cdp console ${targetId} --errors`,
    });
  }

  if (actionResult.dispatch?.ok === true && actionResult.settle?.ok === false) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'observation-timeout',
      confidence: 'medium',
      source: 'settle',
      reason: 'The action was dispatched, but post-action observation did not finish cleanly.',
      nextCommand: `cdp perceive ${targetId} --since-action`,
    });
  }

  if (signals.domChanged) {
    return finish({
      ...base,
      status: 'ok',
      kind: 'dom-changed',
      confidence: 'medium',
      source: 'dom',
      reason: 'The action dispatched and changed the perceived DOM.',
      nextCommand: actionResult.nextHint || `cdp perceive ${targetId} --since-action`,
    });
  }

  return base;
}

function applyActionDiagnosis(actionResult) {
  if (!actionResult.effects) actionResult.effects = {};
  const diagnosis = createActionDiagnosis(actionResult);
  if (diagnosis.status === 'ok' && diagnosis.kind === 'ok') delete actionResult.effects.diagnosis;
  else actionResult.effects.diagnosis = diagnosis;
  return actionResult;
}

function buildActionRecommendation(actionResult = {}) {
  const target = actionTargetCommandPrefix(actionResult.target || {});
  const diagnosis = actionResult.effects?.diagnosis || null;
  if (diagnosis && diagnosis.status !== 'ok') {
    const commands = recoveryCommandsFromDiagnosis(diagnosis);
    return {
      source: 'action-diagnosis',
      action: actionResult.action || null,
      targetPrefix: target,
      diagnosisKind: diagnosis.kind || null,
      strategy: diagnosis.recovery?.strategy || diagnosis.kind || 'recover-action',
      priority: diagnosis.recovery?.priority || (diagnosis.status === 'blocked' ? 'high' : 'medium'),
      verifyCommand: diagnosis.recovery?.verifyCommand || diagnosis.nextCommand || null,
      commands,
    };
  }
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);
  if (outcome.status === 'no-change') {
    return buildNoChangeOutcomeRecommendation({
      action: actionResult.action || null,
      target,
      targetInput: actionFailureInput(actionResult.target || {}),
      targetInfo: actionResult.target || {},
    });
  }

  return {
    source: 'action-evidence',
    action: actionResult.action || null,
    targetPrefix: target,
    strategy: actionResult.effects?.domDiff ? 'continue-from-evidence' : 'continue-or-handoff',
    priority: 'medium',
    reason: actionResult.effects?.domDiff
      ? 'The action already includes observed page evidence; continue from that evidence without an extra verify call.'
      : 'The action dispatched without captured runtime trouble; use report or record-actions when handing off.',
    commands: uniqueNextStepCommands([
      `cdp report ${target} --format json`,
      `cdp record-actions ${target} --format json`,
    ]),
    optionalCommands: uniqueNextStepCommands([
      `cdp perceive ${target} --since-action`,
    ]),
  };
}

function applyActionRecommendation(actionResult) {
  const recommendation = buildActionRecommendation(actionResult);
  actionResult.recommendation = recommendation;
  actionResult.nextSteps = uniqueNextStepCommands(recommendation.commands || []);
  return actionResult;
}

function buildActionVerdict(actionResult = {}) {
  const diagnosis = actionResult.effects?.diagnosis || null;
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);
  const recommendation = actionResult.recommendation || {};
  const nextSteps = uniqueNextStepCommands(recommendation.commands || []);
  const primaryNextStep = nextSteps[0] || recommendation.verifyCommand || actionResult.nextHint || null;
  const base = {
    schema: 'chrome-cdp-ex.action-verdict.v1',
    source: diagnosis && diagnosis.status !== 'ok' ? 'diagnosis' : 'outcome',
    primaryNextStep,
    nextSteps,
    reason: diagnosis && diagnosis.status !== 'ok'
      ? diagnosis.reason || outcome.reason || null
      : outcome.reason || recommendation.reason || null,
  };

  if (diagnosis && diagnosis.status !== 'ok') {
    const blocked = diagnosis.status === 'blocked' || outcome.status === 'failed';
    return {
      ...base,
      status: blocked ? 'blocked' : 'recover',
      confidence: diagnosis.confidence || (blocked ? 'high' : 'medium'),
      canContinue: false,
      needsRecovery: true,
    };
  }

  switch (outcome.status) {
    case 'changed':
      return {
        ...base,
        status: 'continue',
        confidence: 'medium',
        canContinue: true,
        needsRecovery: false,
      };
    case 'no-change':
      return {
        ...base,
        status: 'investigate',
        confidence: 'medium',
        canContinue: false,
        needsRecovery: true,
      };
    case 'failed':
      return {
        ...base,
        status: 'blocked',
        confidence: 'high',
        canContinue: false,
        needsRecovery: true,
      };
    case 'timeout':
      return {
        ...base,
        status: 'verify',
        confidence: 'low',
        canContinue: false,
        needsRecovery: true,
      };
    case 'attention':
      return {
        ...base,
        status: 'recover',
        confidence: 'medium',
        canContinue: false,
        needsRecovery: true,
      };
    case 'dispatched':
    default:
      return {
        ...base,
        status: 'verify',
        confidence: 'low',
        canContinue: false,
        needsRecovery: false,
      };
  }
}

function applyActionVerdict(actionResult) {
  actionResult.verdict = buildActionVerdict(actionResult);
  return actionResult;
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatConsoleDeltaSample(entry) {
  if (!entry) return null;
  const level = entry.level || 'log';
  const loc = entry.loc ? ` @ ${entry.loc}` : '';
  return `[${level}] ${redactSensitiveString(entry.text || '(empty)')}${loc}`;
}

function formatExceptionDeltaSample(entry) {
  if (!entry) return null;
  const loc = entry.loc ? ` @ ${entry.loc}` : '';
  return `${redactSensitiveString(entry.message || 'Unknown exception')}${loc}`;
}

function formatNetworkDeltaSample(entry) {
  if (!entry) return null;
  const status = entry.errorText || entry.status || 'pending';
  const duration = Number.isFinite(entry.duration) ? ` in ${entry.duration}ms` : '';
  return `${entry.method || 'GET'} ${redactSensitiveString(entry.url || '(unknown URL)')} -> ${status}${duration}`;
}

function summarizeActionConsoleDelta(delta = {}) {
  const count = Number(delta.count || 0);
  if (count === 0) return { summary: null, sample: null };
  const parts = [];
  if (delta.errors) parts.push(countLabel(delta.errors, 'error'));
  if (delta.warnings) parts.push(countLabel(delta.warnings, 'warning'));
  const summary = `Console: ${countLabel(count, 'entry', 'entries')}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  const prioritized = [...(delta.entries || [])].find(entry => ['error', 'assert'].includes(String(entry.level || '').toLowerCase()))
    || [...(delta.entries || [])].find(entry => ['warning', 'warn'].includes(String(entry.level || '').toLowerCase()))
    || (delta.entries || [])[0];
  return { summary, sample: formatConsoleDeltaSample(prioritized) };
}

function summarizeActionExceptionDelta(delta = {}) {
  const count = Number(delta.count || 0);
  if (count === 0) return { summary: null, sample: null };
  return {
    summary: `Exception: ${count} thrown`,
    sample: formatExceptionDeltaSample((delta.entries || [])[0]),
  };
}

function summarizeActionNetworkDelta(delta = {}) {
  const count = Number(delta.count || 0);
  if (count === 0) return { summary: null, sample: null };
  const failures = Number(delta.failures || 0);
  const pending = Number(delta.pending || 0);
  const parts = [];
  if (failures) parts.push(countLabel(failures, 'failed', 'failed'));
  if (pending) parts.push(countLabel(pending, 'pending', 'pending'));
  const summary = `Network: ${countLabel(count, 'request')}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  const prioritized = [...(delta.entries || [])].find(isNetworkFailure) || (delta.entries || [])[0];
  return { summary, sample: formatNetworkDeltaSample(prioritized) };
}

function summarizeActionObservationEffects(effects = {}) {
  const consoleSummary = summarizeActionConsoleDelta(effects.consoleDelta);
  const exceptionSummary = summarizeActionExceptionDelta(effects.exceptionDelta);
  const networkSummary = summarizeActionNetworkDelta(effects.networkDelta);
  return {
    consoleSummary: consoleSummary.summary,
    consoleSample: consoleSummary.sample,
    exceptionSummary: exceptionSummary.summary,
    exceptionSample: exceptionSummary.sample,
    networkSummary: networkSummary.summary,
    networkSample: networkSummary.sample,
  };
}

function formatActionText(result) {
  const diagnostics = summarizeActionObservationEffects(result.effects || {});
  const diagnosis = result.effects?.diagnosis || null;
  const lines = [
    `${result.action}: ${result.dispatch.ok ? 'dispatched' : 'failed'} via ${result.dispatch.method}`,
  ];
  if (result.target?.label) lines.push(`Target: ${result.target.label}`);
  if (result.outcome?.status) lines.push(`Outcome: ${result.outcome.status}${result.outcome.reason ? ` — ${result.outcome.reason}` : ''}`);
  if (result.receipt?.outcome) {
    lines.push(`Receipt: ${result.receipt.outcome}`);
    if (Array.isArray(result.receipt.blockingSignals) && result.receipt.blockingSignals.length) {
      lines.push(`Blocking signals: ${result.receipt.blockingSignals.join(', ')}`);
    }
    if (result.receipt.recoveryHint) lines.push(`Recovery hint: ${result.receipt.recoveryHint}`);
  }
  if (result.effects?.failure?.kind) lines.push(`Failure: ${result.effects.failure.kind}`);
  if (diagnosis && diagnosis.status !== 'ok') {
    lines.push(`Diagnosis: ${diagnosis.kind}${diagnosis.reason ? ` — ${diagnosis.reason}` : ''}`);
  }
  if (result.effects?.observationError?.message) lines.push(`Observation error: ${result.effects.observationError.message}`);
  if (result.verdict?.status) {
    lines.push(`Verdict: ${result.verdict.status}${result.verdict.reason ? ` — ${result.verdict.reason}` : ''}`);
  }
  if (result.settle) {
    const duration = result.settle.durationMs ? ` in ${result.settle.durationMs}ms` : '';
    lines.push(`Settle: ${result.settle.ok ? 'ok' : 'not confirmed'}${duration}`);
  }
  if (diagnostics.consoleSummary) lines.push(diagnostics.consoleSummary);
  if (diagnostics.consoleSample) lines.push(`Console sample: ${diagnostics.consoleSample}`);
  if (diagnostics.exceptionSummary) lines.push(diagnostics.exceptionSummary);
  if (diagnostics.exceptionSample) lines.push(`Exception sample: ${diagnostics.exceptionSample}`);
  if (diagnostics.networkSummary) lines.push(diagnostics.networkSummary);
  if (diagnostics.networkSample) lines.push(`Network sample: ${diagnostics.networkSample}`);
  if (result.effects?.domDiff) lines.push('---', redactSensitiveString(result.effects.domDiff));
  if (diagnosis?.nextCommand && diagnosis.status !== 'ok') lines.push(`Next: ${diagnosis.nextCommand}`);
  if (!diagnosis?.nextCommand && result.outcome?.status === 'no-change' && result.recommendation?.commands?.[0]) {
    lines.push(`Next: ${result.recommendation.commands[0]}`);
  }
  if (result.nextHint) lines.push(`Hint: ${result.nextHint}`);
  return lines.join('\n');
}

function finalizeActionResult(result, { enrichActionResult = null, onActionResult = null } = {}) {
  if (enrichActionResult) enrichActionResult(result);
  applyActionReceipt(applyActionVerdict(applyActionRecommendation(applyActionOutcome(applyActionDiagnosis(result)))));
  if (onActionResult) onActionResult(result);
  return result;
}

function normalizeActionOutputOptions(format = 'text') {
  if (format && typeof format === 'object') {
    return {
      format: format.format || 'text',
      compact: format.compact === true || format.qa === true || format.summary === true,
      qa: format.qa === true || format.summary === true,
      maxDiffLines: format.maxDiffLines == null ? null : Number(format.maxDiffLines),
    };
  }
  return { format, compact: false, qa: false, maxDiffLines: null };
}

function formatActionResultOutput(result, { format = 'text', compact = false, qa = false, maxDiffLines = null, dispatchText = '', timeoutError = null } = {}) {
  if (qa) {
    const summary = buildQaSummaryModel({
      page: {
        url: result.effects?.page?.url || result.page?.url || '',
        title: result.effects?.page?.title || result.page?.title || '',
      },
      console: {
        errors: Number(result.effects?.consoleDelta?.errors || 0),
        exceptions: Number(result.effects?.exceptionDelta?.count || 0),
      },
      network: {
        failures: Number(result.effects?.networkDelta?.failures || 0),
      },
      action: {
        outcome: result.outcome?.status || result.receipt?.outcome || null,
        dispatch: result.dispatch || null,
        changed: result.outcome?.status ? result.outcome.status !== 'no-change' : Boolean(result.effects?.domDiff),
      },
      targetPrefix: result.target?.targetId ? targetPrefixForDisplay(result.target.targetId) : null,
      nextCommand: result.recommendation?.commands?.[0] || result.effects?.diagnosis?.nextCommand || null,
      source: 'action',
    });
    if (format === 'json') {
      return formatJson({
        summary,
        action: compactActionResultForJson(result, { compact: true }),
      });
    }
    return formatQaSummaryText(summary);
  }
  if (format === 'json') return formatJson(compactActionResultForJson(result, { compact }));
  let text = dispatchText ? `${dispatchText}\n---\n${formatActionText(result)}` : formatActionText(result);
  if (maxDiffLines != null) text = truncateTextLines(text, maxDiffLines);
  if (!timeoutError) return text;
  return `${text}\n(success but observation timed out after action dispatch: ${timeoutError.message}. The action was already sent; run \`perceive --since-action\`, \`perceive --diff\`, or \`status\` to refresh.)`;
}

function parseVerifyClickArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args;
  const opts = {
    selector: null,
    expectRequest: null,
    expectStatus: null,
    expectText: null,
    noConsoleErrors: false,
    evidence: 'concise',
    format: fopts.format,
  };
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--expect-request') opts.expectRequest = tokens[++i] || '';
    else if (token === '--expect-status') {
      const status = Number(tokens[++i]);
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('verify-click: --expect-status requires an HTTP status code');
      opts.expectStatus = status;
    } else if (token === '--expect-text') opts.expectText = tokens[++i] || '';
    else if (token === '--no-console-errors') opts.noConsoleErrors = true;
    else if (token === '--evidence') {
      const evidence = tokens[++i] || '';
      if (!['concise', 'full'].includes(evidence)) throw new Error('verify-click: --evidence must be concise or full');
      opts.evidence = evidence;
    } else if (String(token).startsWith('--')) {
      throw new Error(`verify-click: unknown argument ${token}`);
    } else {
      positional.push(token);
    }
  }
  if (positional.length !== 1) throw new Error('verify-click requires exactly one selector or @ref');
  opts.selector = positional[0];
  return opts;
}

function normalizeRequestExpectation(pattern = '') {
  const text = String(pattern || '').trim();
  const match = text.match(/^([A-Z]+)\s+(.+)$/);
  return match
    ? { method: match[1], pattern: match[2].trim(), display: `${match[1]} ${match[2].trim()}` }
    : { method: null, pattern: text, display: text };
}

function requestUrlPieces(url = '') {
  try {
    const parsed = new URL(url);
    return {
      full: parsed.href,
      path: `${parsed.pathname}${parsed.search || ''}`,
    };
  } catch {
    return { full: String(url || ''), path: String(url || '') };
  }
}

function wildcardMatch(value = '', pattern = '') {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(String(value || ''));
}

function findExpectedNetworkRequest(entries = [], expectation = '') {
  const expected = normalizeRequestExpectation(expectation);
  return (entries || []).find(entry => {
    if (expected.method && String(entry.method || '').toUpperCase() !== expected.method) return false;
    const pieces = requestUrlPieces(entry.url || '');
    return pieces.path.includes(expected.pattern)
      || pieces.full.includes(expected.pattern)
      || wildcardMatch(pieces.path, expected.pattern)
      || wildcardMatch(pieces.full, expected.pattern);
  }) || null;
}

function buildSemanticInteractionModel(actionResult = {}, opts = {}, observed = {}) {
  const networkEntries = actionResult.effects?.networkDelta?.entries || actionResult.effects?.network || [];
  const consoleDelta = normalizeConsoleDelta(actionResult.effects?.consoleDelta || {});
  const exceptionDelta = normalizeExceptionDelta(actionResult.effects?.exceptionDelta || {});
  const assertions = [];
  let matchedRequest = null;

  if (opts.expectRequest) {
    matchedRequest = findExpectedNetworkRequest(networkEntries, opts.expectRequest);
    const expected = normalizeRequestExpectation(opts.expectRequest);
    const statusOk = opts.expectStatus == null || Number(matchedRequest?.status) === Number(opts.expectStatus);
    assertions.push({
      kind: 'request',
      expected: expected.display,
      expectedStatus: opts.expectStatus,
      status: matchedRequest && statusOk ? 'pass' : 'fail',
      matched: matchedRequest ? {
        method: matchedRequest.method || null,
        url: matchedRequest.url || null,
        status: matchedRequest.status ?? null,
        duration: matchedRequest.duration ?? null,
      } : null,
      message: matchedRequest
        ? `${expected.display} -> ${matchedRequest.status ?? 'unknown'} ${statusOk ? 'matched' : 'status-mismatch'}`
        : `${expected.display} not observed`,
    });
  }

  if (opts.expectText) {
    const matched = observed.textMatched === true;
    assertions.push({
      kind: 'text',
      expected: opts.expectText,
      status: matched ? 'pass' : 'fail',
      message: matched ? `"${opts.expectText}" matched` : `"${opts.expectText}" not found`,
    });
  }

  if (opts.noConsoleErrors) {
    const errors = Number(consoleDelta.errors || 0) + Number(exceptionDelta.count || 0);
    assertions.push({
      kind: 'console',
      expected: 'no console errors',
      status: errors === 0 ? 'pass' : 'fail',
      errors,
      warnings: Number(consoleDelta.warnings || 0),
      message: errors === 0 ? 'clean' : `${errors} error${errors === 1 ? '' : 's'}`,
    });
  }

  const dispatchOk = actionResult.dispatch?.ok !== false;
  const verdict = dispatchOk && assertions.every(assertion => assertion.status === 'pass') ? 'pass' : 'fail';
  return {
    schema: 'chrome-cdp-ex.semantic-interaction.v1',
    action: actionResult.action || 'click',
    target: actionResult.target?.input || actionResult.target?.label || opts.selector || null,
    dispatch: actionResult.dispatch || null,
    settlement: buildSettlementReceipt(actionResult),
    outcome: actionResult.outcome?.status || buildActionOutcome(actionResult).status,
    verdict,
    assertions,
    matchedRequest,
    actionEvidence: opts.evidence === 'full' ? actionResult : null,
  };
}

function formatSemanticInteractionResult(model) {
  const lines = [
    `Action: ${model.action}${model.target ? ` ${model.target}` : ''}`,
    `Dispatch: ${model.dispatch?.ok === false ? 'failed' : 'ok'}`,
  ];
  for (const assertion of model.assertions || []) {
    if (assertion.kind === 'request') {
      lines.push(`Request: ${assertion.message}`);
    } else if (assertion.kind === 'text') {
      lines.push(`Text: ${assertion.message}`);
    } else if (assertion.kind === 'console') {
      lines.push(`Console: ${assertion.message}`);
    } else {
      lines.push(`${assertion.kind}: ${assertion.message || assertion.status}`);
    }
  }
  lines.push(`Verdict: ${model.verdict}`);
  return lines.join('\n');
}

function parseQaArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = {
    desktop: '1440x900',
    mobile: '390x844',
    click: null,
    expectRequest: null,
    expectStatus: null,
    expectText: null,
    noConsoleErrors: false,
    format: fopts.format,
  };
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--desktop') opts.desktop = fopts.args[++i] || opts.desktop;
    else if (token === '--mobile') opts.mobile = fopts.args[++i] || opts.mobile;
    else if (token === '--click') opts.click = fopts.args[++i] || '';
    else if (token === '--expect-request') opts.expectRequest = fopts.args[++i] || '';
    else if (token === '--expect-status') {
      const status = Number(fopts.args[++i]);
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('qa: --expect-status requires an HTTP status code');
      opts.expectStatus = status;
    } else if (token === '--expect-text') opts.expectText = fopts.args[++i] || '';
    else if (token === '--no-console-errors') opts.noConsoleErrors = true;
    else throw new Error(`qa: unknown argument ${token}`);
  }
  return opts;
}

function parseResponsiveAuditArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = {
    format: fopts.format,
    viewports: [],
    outDir: null,
    maxControls: 12,
  };
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--viewport' || token === '-V') {
      const size = fopts.args[++i];
      if (!size) throw new Error('responsive-audit: --viewport requires WxH');
      opts.viewports.push(size);
    } else if (token === '--out-dir' || token === '--output-dir') {
      opts.outDir = fopts.args[++i] || null;
      if (!opts.outDir) throw new Error('responsive-audit: --out-dir requires a path');
    } else if (token === '--max-controls') {
      opts.maxControls = parseNonNegativeInteger(fopts.args[++i], 'responsive-audit: --max-controls');
    } else {
      throw new Error(`responsive-audit: unknown argument ${token}`);
    }
  }
  if (!opts.viewports.length) opts.viewports = ['1440x900', '390x844'];
  return opts;
}

function responsiveAuditViewportScript({ maxControls = 12 } = {}) {
  const limit = Math.max(0, Math.min(Number(maxControls) || 12, 100));
  return `(function() {
    const doc = document.documentElement;
    const body = document.body;
    const scrollWidth = Math.max(doc?.scrollWidth || 0, body?.scrollWidth || 0);
    const scrollHeight = Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0);
    const clientWidth = doc?.clientWidth || window.innerWidth || 0;
    const clientHeight = doc?.clientHeight || window.innerHeight || 0;
    const overflowX = scrollWidth > clientWidth + 1;
    const allControls = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
    const controls = allControls
      .slice(0, ${limit})
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
      }));
    const blank = !(document.body && (document.body.innerText || '').trim()) && document.querySelectorAll('*').length < 8;
    return JSON.stringify({
      url: location.href,
      title: document.title,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      scroll: { width: scrollWidth, height: scrollHeight, clientWidth, clientHeight },
      overflowX,
      controlCount: allControls.length,
      controls,
      controlsTruncated: allControls.length > ${limit},
      maxControls: ${limit},
      blank,
    });
  })()`;
}

function countNetworkFailures(netReqBuf = null) {
  if (!netReqBuf || typeof netReqBuf.all !== 'function') return 0;
  return netReqBuf.all().filter(isNetworkFailure).length;
}

function buildResponsiveAuditModel({
  targetId = '',
  viewports = [],
  page = {},
  console: consoleHealth = {},
  errors = [],
} = {}) {
  const checks = viewports.map(entry => {
    let status = 'pass';
    if (entry.error) status = 'fail';
    else if (entry.blank || entry.overflowX || Number(consoleHealth.errors || 0) > 0) status = 'warn';
    return {
      viewport: entry.viewport,
      status,
      url: entry.url || page.url || '',
      title: entry.title || page.title || '',
      screenshot: entry.screenshot || null,
      overflowX: Boolean(entry.overflowX),
      blank: Boolean(entry.blank),
      scroll: entry.scroll || null,
      controlCount: entry.controlCount ?? null,
      controls: entry.controls || [],
      error: entry.error || null,
    };
  });
  const verdict = checks.some(c => c.status === 'fail')
    ? 'fail'
    : checks.some(c => c.status === 'warn')
      ? 'warn'
      : 'pass';
  return {
    schema: 'chrome-cdp-ex.responsive-audit.v1',
    targetId,
    targetPrefix: targetPrefixForDisplay(targetId),
    page,
    console: consoleHealth,
    viewports: checks,
    errors,
    verdict,
    summary: {
      pass: checks.filter(c => c.status === 'pass').length,
      warn: checks.filter(c => c.status === 'warn').length,
      fail: checks.filter(c => c.status === 'fail').length,
    },
    nextSteps: [
      `cdp shot ${targetPrefixForDisplay(targetId)}`,
      `cdp perceive ${targetPrefixForDisplay(targetId)} -C -d 8`,
      `cdp report ${targetPrefixForDisplay(targetId)}`,
    ],
  };
}

function formatResponsiveAuditReport(model) {
  const lines = [
    `Responsive audit: ${model.verdict}`,
    `Page: ${model.page?.title || '(untitled)'}`,
    `URL: ${model.page?.url || '(unknown)'}`,
    `Console: ${model.console?.errors || 0} errors, ${model.console?.warnings || 0} warnings`,
    `Summary: ${model.summary.pass} pass / ${model.summary.warn} warn / ${model.summary.fail} fail`,
  ];
  for (const vp of model.viewports || []) {
    lines.push(`- ${vp.viewport}: ${vp.status}` +
      `${vp.overflowX ? ' overflow-x' : ''}` +
      `${vp.blank ? ' blank' : ''}` +
      `${vp.controlCount != null ? ` controls=${vp.controlCount}` : ''}` +
      `${vp.screenshot ? ` shot=${vp.screenshot}` : ''}` +
      `${vp.error ? ` error=${vp.error}` : ''}`);
  }
  for (const error of model.errors || []) lines.push(`Error: ${error}`);
  if (model.nextSteps?.[0]) lines.push(`Next: ${model.nextSteps[0]}`);
  return lines.join('\n');
}

async function responsiveAuditStr(cdp, sid, session, targetId, consoleBuf, exceptionBuf, args = []) {
  const opts = parseResponsiveAuditArgs(args);
  const page = await pageInfoModel(cdp, sid, { targetPrefix: targetPrefixForDisplay(targetId) });
  const consoleHealth = {
    errors: consoleBuf.all().filter(entry => entry.level === 'error').length,
    warnings: consoleBuf.all().filter(entry => entry.level === 'warning' || entry.level === 'warn').length,
    exceptions: exceptionBuf.all().length,
  };
  const viewports = [];
  const errors = [];
  for (const size of opts.viewports) {
    const entry = { viewport: size };
    try {
      await viewportStr(cdp, sid, size);
      const metricsRaw = await evalStr(cdp, sid, responsiveAuditViewportScript({ maxControls: opts.maxControls }));
      const metrics = JSON.parse(metricsRaw);
      Object.assign(entry, metrics);
      const shotDir = opts.outDir || session.screenshotDir || null;
      if (opts.outDir) {
        try { mkdirSync(opts.outDir, { recursive: true }); } catch {}
      } else {
        ensureSessionScreenshotDir(session);
      }
      const path = opts.outDir
        ? resolve(opts.outDir, `responsive-${size.replace(/[^0-9x]/gi, 'x')}-${Date.now()}.png`)
        : nextSessionScreenshotPath(session, `responsive-${size}`);
      const shot = await shotStr(cdp, sid, path, targetId, { quiet: true });
      entry.screenshot = shot.split('\n')[0];
      appendSessionScreenshot(session, { kind: 'responsive-audit', path: entry.screenshot, note: size });
      if (!shotDir && !opts.outDir) {
        // default screenshots stay under session dir outside the repo
      }
    } catch (e) {
      entry.error = e.message || String(e);
      errors.push(`${size}: ${entry.error}`);
    }
    viewports.push(entry);
  }
  const model = buildResponsiveAuditModel({
    targetId,
    viewports,
    page: { title: page.title, url: page.url },
    console: consoleHealth,
    errors,
  });
  return opts.format === 'json' ? formatJson(model) : formatResponsiveAuditReport(model);
}

function buildQaPageModel({ targetId = '', page = {}, console: consoleHealth = {}, perception = null, screenshots = {}, action = null, assertions = [], errors = [] } = {}) {
  const checks = {
    page: page?.url || page?.title ? 'pass' : 'fail',
    console: Number(consoleHealth.errors || 0) === 0 && Number(consoleHealth.exceptions || 0) === 0 ? 'pass' : 'fail',
    desktopScreenshot: screenshots.desktop?.path ? 'pass' : 'skip',
    mobileScreenshot: screenshots.mobile?.path ? 'pass' : 'skip',
    assertions: assertions.length ? (assertions.every(assertion => assertion.status === 'pass') ? 'pass' : 'fail') : 'skip',
    action: action ? action.verdict : 'skip',
  };
  if (errors.length) checks.errors = 'fail';
  const verdict = Object.values(checks).some(status => status === 'fail') ? 'fail' : 'pass';
  return {
    schema: 'chrome-cdp-ex.qa-page.v1',
    targetId,
    targetPrefix: targetPrefixForDisplay(targetId),
    page,
    console: consoleHealth,
    perception,
    screenshots,
    action,
    assertions,
    errors,
    checks,
    verdict,
    nextSteps: [
      `cdp report ${targetPrefixForDisplay(targetId)} --format json`,
      `cdp perceive ${targetPrefixForDisplay(targetId)} -C -d 8`,
    ],
  };
}

function formatQaPageReport(model) {
  const lines = [
    `QA page: ${model.page?.title || '(untitled)'}`,
    `URL: ${model.page?.url || '(unknown)'}`,
    `Page: ${model.checks.page}`,
    `Console: ${model.checks.console}${model.console ? ` (${model.console.errors || 0} errors, ${model.console.warnings || 0} warnings, ${model.console.exceptions || 0} exceptions)` : ''}`,
  ];
  if (model.screenshots?.desktop?.path) lines.push(`Desktop screenshot: ${model.screenshots.desktop.path}`);
  if (model.screenshots?.mobile?.path) lines.push(`Mobile screenshot: ${model.screenshots.mobile.path}`);
  if (model.action) {
    lines.push(`Action: ${model.action.verdict}`);
    for (const assertion of model.action.assertions || []) {
      lines.push(`  ${assertion.kind}: ${assertion.status} — ${assertion.message || assertion.expected}`);
    }
  }
  if (model.assertions?.length) {
    lines.push('Assertions:');
    for (const assertion of model.assertions) {
      lines.push(`  ${assertion.kind}: ${assertion.status} — ${assertion.message || assertion.expected}`);
    }
  }
  for (const error of model.errors || []) lines.push(`Error: ${error}`);
  lines.push(`Verdict: ${model.verdict}`);
  return lines.join('\n');
}

async function pageContainsText(cdp, sid, text) {
  if (!text) return false;
  const raw = await evalStr(cdp, sid, `(function() {
    const needle = ${JSON.stringify(String(text))};
    const body = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    return JSON.stringify({ matched: body.includes(needle) });
  })()`);
  try {
    return JSON.parse(raw).matched === true;
  } catch {
    return false;
  }
}

async function runActionWithFeedback({ action, target = null, dispatch, feedbackPolicy, observe, dispatchMethod = action, nextHint = 'Use perceive --since-action if more evidence is needed', enrichActionResult = null, onActionResult = null, format = 'text' }) {
  const output = normalizeActionOutputOptions(format);
  const startedAt = Date.now();
  let dispatchText;
  try {
    dispatchText = await dispatch();
  } catch (e) {
    const failure = classifyActionFailure(e, { action, target });
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: false, method: dispatchMethod, error: failure.originalMessage },
      settle: { ok: false, durationMs: Date.now() - startedAt },
      effects: { domDiff: null, console: [], network: [], navigation: null, failure },
      nextHint: failure.nextCommand,
    });
    finalizeActionResult(result, { enrichActionResult, onActionResult });
    if (output.format === 'json') return formatActionResultOutput(result, output);
    throw new Error(formatActionFailure(e, { action, target }));
  }
  if (feedbackPolicy === 'none' || feedbackPolicy === 'report-only') {
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: true, durationMs: Date.now() - startedAt },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: feedbackPolicy === 'report-only' ? nextHint : null,
    });
    finalizeActionResult(result, { enrichActionResult, onActionResult });
    if (feedbackPolicy === 'none') return dispatchText;
    return formatActionResultOutput(result, { ...output, dispatchText });
  }
  try {
    const domDiff = await observe();
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: true, durationMs: Date.now() - startedAt },
      effects: { domDiff, console: [], network: [], navigation: null },
      nextHint,
    });
    finalizeActionResult(result, { enrichActionResult, onActionResult });
    return formatActionResultOutput(result, { ...output, dispatchText });
  } catch (e) {
    const observationError = isTimeoutError(e) ? null : compactObservationError(e);
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: false, durationMs: Date.now() - startedAt },
      effects: {
        domDiff: null,
        console: [],
        network: [],
        navigation: null,
        ...(observationError ? { observationError } : {}),
      },
      nextHint,
    });
    finalizeActionResult(result, { enrichActionResult, onActionResult });
    return formatActionResultOutput(result, {
      ...output,
      dispatchText,
      timeoutError: observationError ? null : e,
    });
  }
}

const HIGH_SIGNAL_ACTION_TEXT_RE = /\b(saved|success|succeeded|complete|completed|done|created|updated|deleted|failed|failure|error|warning|invalid|required)\b|成功|勝利|完成|已儲存|儲存|失敗|錯誤|警告|無效|必填/i;

function actionDomDiffSampleScore(line = '') {
  const trimmed = String(line || '').trim();
  let score = 0;
  if (trimmed.startsWith('+')) score += 2;
  if (/^\+\s+\[(alert|status|statustext|statictext|heading)\]/i.test(trimmed)) score += 2;
  if (HIGH_SIGNAL_ACTION_TEXT_RE.test(trimmed)) score += 4;
  if (/^-\s/.test(trimmed)) score -= 2;
  return score;
}

function chooseActionDomDiffSample(lines = []) {
  const samples = lines.filter(l => /^[+-]\s/.test(l));
  if (!samples.length) return null;
  return samples
    .map((line, index) => ({ line, index, score: actionDomDiffSampleScore(line) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0].line;
}

function summarizeActionDomDiff(domDiff) {
  const lines = String(domDiff || '').split('\n').map(l => l.trim()).filter(Boolean);
  const summary = lines.find(l =>
    l.startsWith('+++ Added') ||
    l.startsWith('--- Removed') ||
    l.startsWith('~~~ Text nodes updated') ||
    l.includes('no changes detected')
  ) || null;
  const sample = chooseActionDomDiffSample(lines);
  return { summary, sample };
}

function compactActionTargetModel(target = null) {
  if (!target || typeof target !== 'object') return target;
  const compact = {};
  for (const field of ['targetId', 'input', 'resolvedBy', 'label', 'frameRef', 'redacted']) {
    if (target[field] !== undefined && target[field] !== null && target[field] !== '') compact[field] = target[field];
  }
  return compact;
}

function compactActionDeltaModel(delta = {}, fields = []) {
  const compact = {
    count: numericDeltaCount(delta.count, 0),
  };
  for (const field of fields) {
    compact[field] = numericDeltaCount(delta[field], 0);
  }
  const entries = Array.isArray(delta.entries) ? delta.entries.filter(Boolean) : [];
  const signal = entries.find(entry => (
    entry?.level === 'error'
    || entry?.level === 'warning'
    || entry?.level === 'warn'
    || entry?.failed === true
    || entry?.errorText
    || Number(entry?.status) >= 400
    || entry?.pending === true
  )) || entries[0];
  if (signal) {
    compact.sample = Object.fromEntries(Object.entries(signal).filter(([, value]) => (
      value !== null && value !== undefined && value !== '' && value !== false
    )));
  }
  return compact;
}

function compactActionFailureModel(failure = null) {
  if (!failure || typeof failure !== 'object') return null;
  return {
    kind: failure.kind || 'unknown',
    reason: failure.reason || failure.originalMessage || null,
    nextCommand: failure.nextCommand || null,
  };
}

function compactActionRecommendationModel(recommendation = null) {
  if (!recommendation || typeof recommendation !== 'object') return null;
  const compact = {};
  for (const field of ['source', 'strategy', 'action', 'targetPrefix', 'outcomeStatus', 'diagnosisKind', 'priority', 'verifyCommand']) {
    if (recommendation[field] !== undefined && recommendation[field] !== null && recommendation[field] !== '') {
      compact[field] = recommendation[field];
    }
  }
  for (const field of ['commands', 'blockingSignals']) {
    if (Array.isArray(recommendation[field]) && recommendation[field].length) compact[field] = recommendation[field];
  }
  return compact;
}

function compactActionOutcomeModel(outcome = null) {
  if (!outcome || typeof outcome !== 'object') return null;
  return {
    status: outcome.status || 'unknown',
    changed: outcome.changed ?? null,
    needsAttention: outcome.needsAttention === true,
    evidence: outcome.evidence || null,
  };
}

function compactActionVerdictForJson(verdict = null) {
  if (!verdict || typeof verdict !== 'object') return null;
  return {
    status: verdict.status || 'verify',
    canContinue: verdict.canContinue === true,
    needsRecovery: verdict.needsRecovery === true,
    primaryNextStep: verdict.primaryNextStep || null,
  };
}

function receiptForCompactActionJson(receipt = null) {
  const base = receiptForActionJson(receipt);
  if (!base || typeof base !== 'object') return base;
  return {
    schema: base.schema || 'chrome-cdp-ex.action-receipt.v1',
    eventId: base.eventId || null,
    sequence: base.sequence ?? null,
    dispatch: base.dispatch || null,
    settlement: {
      state: base.settlement?.state || null,
      strategy: base.settlement?.strategy || null,
      durationMs: Number.isFinite(base.settlement?.durationMs) ? base.settlement.durationMs : null,
      signals: Array.isArray(base.settlement?.signals) ? base.settlement.signals : [],
    },
    outcome: base.outcome || null,
    observedDelta: Array.isArray(base.observedDelta) ? base.observedDelta.slice(0, 2) : [],
    observedDeltaDetails: Array.isArray(base.observedDeltaDetails) ? base.observedDeltaDetails.slice(0, 2) : [],
    blockingSignals: Array.isArray(base.blockingSignals) ? base.blockingSignals : [],
    recoveryHint: base.recoveryHint || null,
    nextSteps: Array.isArray(base.nextSteps) ? base.nextSteps : [],
  };
}

function compactActionEffectsModel(effects = {}) {
  const compact = {};
  if (typeof effects.domDiff === 'string') {
    const summary = effects.domDiffSummary || summarizeActionDomDiff(effects.domDiff).summary;
    const sample = effects.domDiffSample || summarizeActionDomDiff(effects.domDiff).sample;
    compact.domDiffChars = Number.isFinite(effects.domDiffChars) ? effects.domDiffChars : effects.domDiff.length;
    compact.domDiffSummary = summary || 'DOM observation captured';
    if (sample) compact.domDiffSample = sample;
    if (effects.domDiffTruncated === true || effects.domDiff.length > MAX_ACTION_JSON_DOM_DIFF_CHARS) {
      compact.domDiffTruncated = true;
    }
  } else if (Object.hasOwn(effects, 'domDiff')) {
    compact.domDiff = effects.domDiff ?? null;
    if (compact.domDiff == null) compact.domDiffSummary = 'DOM observation not captured';
  } else {
    compact.domDiff = null;
    compact.domDiffSummary = 'DOM observation not captured';
  }
  compact.consoleDelta = compactActionDeltaModel(normalizeConsoleDelta(effects.consoleDelta || {}), ['errors', 'warnings']);
  compact.exceptionDelta = compactActionDeltaModel(normalizeExceptionDelta(effects.exceptionDelta || {}));
  compact.networkDelta = compactActionDeltaModel(normalizeNetworkDelta(effects.networkDelta || {}), ['failures', 'pending']);
  const failure = compactActionFailureModel(effects.failure);
  if (failure) compact.failure = failure;
  const diagnosis = compactActionDiagnosisModel(effects.diagnosis);
  if (diagnosis && diagnosis.status !== 'ok') compact.diagnosis = diagnosis;
  if (effects.observationError?.message) compact.observationError = effects.observationError;
  return compact;
}

function compactActionHandoffForJson(result = {}) {
  return {
    schema: result.schema || 'chrome-cdp-ex.action.v1',
    mode: 'compact',
    action: result.action || null,
    target: compactActionTargetModel(result.target || null),
    dispatch: result.dispatch || null,
    settle: result.settle || null,
    effects: compactActionEffectsModel(result.effects || {}),
    outcome: compactActionOutcomeModel(result.outcome),
    verdict: compactActionVerdictForJson(result.verdict),
    recommendation: compactActionRecommendationModel(result.recommendation),
    nextSteps: Array.isArray(result.nextSteps) ? result.nextSteps : [],
    receipt: receiptForCompactActionJson(result.receipt),
  };
}

function compactActionResultForJson(result, { compact: compactMode = false } = {}) {
  const compact = JSON.parse(JSON.stringify(result));
  compact.target = sanitizeActionTargetForLog(compact.action, compact.target || null);
  compact.receipt = receiptForActionJson(compact.receipt);
  const effects = compact.effects || {};
  if (typeof effects.domDiff !== 'string') {
    const redacted = redactSensitiveArtifactValue(compact);
    return compactMode ? compactActionHandoffForJson(redacted) : redacted;
  }

  const original = effects.domDiff;
  const { summary, sample } = summarizeActionDomDiff(original);
  effects.domDiffChars = original.length;
  effects.domDiffSummary = summary;
  effects.domDiffSample = sample;
  effects.domDiffTruncated = original.length > MAX_ACTION_JSON_DOM_DIFF_CHARS;
  if (effects.domDiffTruncated) {
    effects.domDiff = [summary, sample].filter(Boolean).join('\n')
      || compactActionText(original, MAX_ACTION_JSON_DOM_DIFF_CHARS);
  }
  const redacted = redactSensitiveArtifactValue(compact);
  return compactMode ? compactActionHandoffForJson(redacted) : redacted;
}

const SENSITIVE_ACTION_TARGET_RE = /\b(pass(word)?|secret|token|api[-_]?key|credential|otp|2fa|mfa|auth(orization)?|pin|cvv|card|ssn)\b/i;

function isSensitiveActionTarget(action, target = {}) {
  if (action !== 'fill' && action !== 'type') return false;
  const probe = [
    target.input,
    target.label,
    ...(Array.isArray(target.commandArgs) ? target.commandArgs.slice(0, 1) : []),
  ].filter(Boolean).join(' ');
  return SENSITIVE_ACTION_TARGET_RE.test(probe);
}

function sanitizeActionTargetForLog(action, target = null) {
  if (!target || typeof target !== 'object') return target;
  const sanitized = {
    ...target,
    commandArgs: Array.isArray(target.commandArgs) ? [...target.commandArgs] : target.commandArgs,
  };
  if (isSensitiveActionTarget(action, sanitized) && Array.isArray(sanitized.commandArgs) && sanitized.commandArgs.length > 1) {
    sanitized.commandArgs = sanitized.commandArgs.map((arg, index) => index === 0 ? arg : '<redacted>');
    sanitized.redacted = [...(sanitized.redacted || []), 'commandArgs'];
  }
  return sanitized;
}

function sessionLogPath(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}.log`);
}

function sessionScreenshotDir(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}-screenshots`);
}

function directoryArtifactStats(dir) {
  let sizeBytes = 0;
  let fileCount = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    const stats = lstatSync(fullPath);
    if (stats.isDirectory()) {
      const child = directoryArtifactStats(fullPath);
      sizeBytes += child.sizeBytes;
      fileCount += child.fileCount;
    } else {
      sizeBytes += stats.size;
      fileCount += 1;
    }
  }
  return { sizeBytes, fileCount };
}

function artifactPathStats(path) {
  if (!path) {
    return {
      path: null,
      exists: false,
      kind: null,
      sizeBytes: null,
      fileCount: 0,
      error: null,
    };
  }
  try {
    const stats = lstatSync(path);
    if (stats.isDirectory()) {
      const dir = directoryArtifactStats(path);
      return {
        path,
        exists: true,
        kind: 'directory',
        sizeBytes: dir.sizeBytes,
        fileCount: dir.fileCount,
        error: null,
      };
    }
    return {
      path,
      exists: true,
      kind: stats.isSymbolicLink() ? 'symlink' : 'file',
      sizeBytes: stats.size,
      fileCount: 1,
      error: null,
    };
  } catch (e) {
    return {
      path,
      exists: false,
      kind: null,
      sizeBytes: null,
      fileCount: 0,
      error: e.message,
    };
  }
}

function buildSessionArtifactsSummary(session = {}) {
  const screenshots = session.screenshots || [];
  const screenshotItems = screenshots.map(entry => artifactPathStats(entry.path));
  const screenshotTotalBytes = screenshotItems.reduce((sum, item) => sum + (Number.isFinite(item.sizeBytes) ? item.sizeBytes : 0), 0);
  const log = artifactPathStats(session.logPath || null);
  const screenshotDir = artifactPathStats(session.screenshotDir || null);
  return {
    paths: {
      log: session.logPath || null,
      screenshotDir: session.screenshotDir || null,
    },
    counts: {
      actions: session.actionLog?.length || 0,
      screenshots: screenshots.length,
      records: session.records?.length || 0,
    },
    sizes: {
      log,
      screenshotDir,
      screenshots: {
        count: screenshots.length,
        totalBytes: screenshotTotalBytes,
        missing: screenshotItems.filter(item => !item.exists).length,
      },
    },
  };
}

function buildReportBudget(timelineWindow = {}) {
  const expensive = timelineWindow.limit == null;
  return {
    jsonBytesMax: DEFAULT_REPORT_JSON_BYTES_MAX,
    estimatedJsonBytes: null,
    defaultActionLimit: DEFAULT_REPORT_ACTION_LIMIT,
    actionLimit: timelineWindow.limit,
    allActionsOptIn: true,
    expensive,
    warning: expensive
      ? 'report --all includes the full action history and can be expensive for long sessions.'
      : 'Default report JSON is bounded; --all is opt-in and expensive for long sessions.',
  };
}

function buildArtifactCleanupWorkflow(session = {}) {
  const targets = [session.logPath || null, session.screenshotDir || null].filter(Boolean);
  return {
    staleAfterHours: DEFAULT_STALE_ARTIFACT_HOURS,
    targets,
    workflow: [
      'Remove stale session artifacts after preserving any evidence needed for handoff or debugging.',
      'Delete the listed log file and screenshot directory when the browser session is no longer active.',
      'Use report --format json to re-check artifact paths, counts, and sizes before cleanup.',
    ],
  };
}

function nextSessionScreenshotPath(session, kind = 'shot') {
  const safeKind = String(kind || 'shot').replace(/[^A-Za-z0-9_.-]/g, '_');
  const dir = session.screenshotDir || sessionScreenshotDir(session.targetId);
  const seq = String((session.screenshots?.length || 0) + 1).padStart(3, '0');
  return resolve(dir, `${safeKind}-${seq}.png`);
}

function ensureSessionScreenshotDir(session) {
  if (!session.screenshotDir) return null;
  try {
    mkdirSync(session.screenshotDir, { recursive: true, mode: 0o700 });
    return session.screenshotDir;
  } catch (e) {
    if (!session.logErrors) session.logErrors = [];
    session.logErrors.push({ ts: Date.now(), message: `screenshot-dir: ${e.message}` });
    return null;
  }
}

function appendSessionEventLog(session, event, { writer = appendFileSync } = {}) {
  if (!session.logPath) return null;
  const payload = {
    schema: 'chrome-cdp-ex.session-event.v1',
    targetId: session.targetId,
    sessionId: session.sessionId,
    ...event,
  };
  try {
    writer(session.logPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return payload;
  } catch (e) {
    if (!session.logErrors) session.logErrors = [];
    session.logErrors.push({ ts: Date.now(), message: e.message });
    return null;
  }
}

function appendSessionEnvironmentLog(session, event, { ts = Date.now() } = {}) {
  if (!session.environmentLog) session.environmentLog = [];
  const entry = { ...event, ts: event.ts ?? ts };
  session.environmentLog.push(entry);
  if (session.environmentLog.length > MAX_ENVIRONMENT_LOG_ENTRIES) {
    session.environmentLog.splice(0, session.environmentLog.length - MAX_ENVIRONMENT_LOG_ENTRIES);
  }
  appendSessionEventLog(session, entry);
  return entry;
}

function initializeSessionLog(session, { ts = session.createdAt || Date.now(), writer = writeFileSync } = {}) {
  if (!session.logPath) return null;
  const payload = {
    schema: 'chrome-cdp-ex.session-event.v1',
    kind: 'session-start',
    ts,
    targetId: session.targetId,
    sessionId: session.sessionId,
  };
  try {
    writer(session.logPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return payload;
  } catch (e) {
    if (!session.logErrors) session.logErrors = [];
    session.logErrors.push({ ts: Date.now(), message: e.message });
    return null;
  }
}

function nextSessionActionSequence(session) {
  const current = Number.isInteger(session.actionSeq) ? session.actionSeq : (session.actionLog?.length || 0);
  session.actionSeq = current + 1;
  return session.actionSeq;
}

function sessionActionEventId(session, sequence) {
  const target = targetPrefixForDisplay(session.targetId || 'target');
  return `act_${target}_${String(sequence).padStart(6, '0')}`;
}

function applyActionReceiptEvent(actionResult, { eventId, sequence, ts } = {}) {
  actionResult.receipt = {
    ...buildActionReceipt(actionResult),
    eventId,
    sequence,
    loggedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
  };
  return actionResult.receipt;
}

function appendSessionActionLog(session, actionResult, { ts = Date.now() } = {}) {
  if (!session.actionLog) session.actionLog = [];
  const sequence = nextSessionActionSequence(session);
  const eventId = sessionActionEventId(session, sequence);
  const receipt = applyActionReceiptEvent(actionResult, { eventId, sequence, ts });
  const domDiff = actionResult.effects?.domDiff || '';
  const { summary, sample } = summarizeActionDomDiff(domDiff);
  const diagnostics = summarizeActionObservationEffects(actionResult.effects || {});
  const target = sanitizeActionTargetForLog(actionResult.action, actionResult.target || null);
  const entry = redactSensitiveArtifactValue({
    sequence,
    eventId,
    ts,
    action: actionResult.action,
    target,
    dispatch: actionResult.dispatch || null,
    settle: actionResult.settle || null,
    effectSummary: summary,
    effectSample: sample,
    consoleSummary: diagnostics.consoleSummary,
    consoleSample: diagnostics.consoleSample,
    exceptionSummary: diagnostics.exceptionSummary,
    exceptionSample: diagnostics.exceptionSample,
    networkSummary: diagnostics.networkSummary,
    networkSample: diagnostics.networkSample,
    failure: actionResult.effects?.failure || null,
    diagnosis: actionResult.effects?.diagnosis || null,
    outcome: actionResult.outcome || buildActionOutcome(actionResult),
    verdict: actionResult.verdict || buildActionVerdict(actionResult),
    receipt,
    nextHint: actionResult.nextHint || null,
  });
  session.actionLog.push(entry);
  if (session.actionLog.length > MAX_ACTION_LOG_ENTRIES) {
    session.actionLog.splice(0, session.actionLog.length - MAX_ACTION_LOG_ENTRIES);
  }
  appendSessionEventLog(session, { kind: 'action', ts, action: entry });
  return entry;
}

function appendSessionScreenshot(session, { kind = 'shot', path = null, note = '', ts = Date.now() } = {}) {
  if (!session.screenshots) session.screenshots = [];
  const entry = {
    ts,
    kind,
    path: path || nextSessionScreenshotPath(session, kind),
    note,
  };
  session.screenshots.push(entry);
  if (session.screenshots.length > MAX_SCREENSHOT_ENTRIES) {
    session.screenshots.splice(0, session.screenshots.length - MAX_SCREENSHOT_ENTRIES);
  }
  appendSessionEventLog(session, { kind: 'screenshot', ts, screenshot: entry });
  return entry;
}

function reportActionStatus(entry = {}) {
  return entry.dispatch?.ok === false ? 'failed' : (entry.settle?.ok ? 'ok' : 'not-confirmed');
}

function buildLatestReportActionSummary(actionLog = []) {
  if (!actionLog.length) return null;
  const index = actionLog.length;
  const entry = actionLog[index - 1] || {};
  return {
    index,
    sequence: entry.sequence ?? index,
    eventId: entry.eventId || entry.receipt?.eventId || null,
    ts: entry.ts || null,
    action: entry.action || null,
    status: reportActionStatus(entry),
    outcomeStatus: entry.outcome?.status || null,
    verdictStatus: entry.verdict?.status || null,
    canContinue: entry.verdict?.canContinue ?? null,
    needsRecovery: entry.verdict?.needsRecovery ?? null,
    effectSummary: entry.effectSummary || null,
    effectSample: entry.effectSample || null,
    consoleSummary: entry.consoleSummary || null,
    networkSummary: entry.networkSummary || null,
    diagnosisKind: entry.diagnosis?.kind || null,
    nextHint: entry.nextHint || null,
  };
}

function compactReportActionTarget(target = null) {
  if (!target || typeof target !== 'object') return target;
  const compact = {};
  for (const field of ['input', 'label', 'resolvedBy', 'frameRef']) {
    if (target[field] !== undefined && target[field] !== null && target[field] !== '') compact[field] = target[field];
  }
  return compact;
}

function compactReportActionEvidence(entry = {}) {
  return {
    dispatchMethod: entry.dispatch?.method || null,
    settleOk: entry.settle?.ok ?? null,
    settleDurationMs: entry.settle?.durationMs ?? null,
    effectSummary: entry.effectSummary || null,
    effectSample: entry.effectSample || null,
    consoleSummary: entry.consoleSummary || null,
    exceptionSummary: entry.exceptionSummary || null,
    networkSummary: entry.networkSummary || null,
    failure: entry.failure?.kind || entry.failure || null,
    diagnosis: entry.diagnosis?.kind || entry.diagnosis || null,
  };
}

function reportActionModel(entry = {}, index = 1, { compact = false } = {}) {
  if (compact) {
    return {
      index,
      sequence: entry.sequence ?? index,
      eventId: entry.eventId || entry.receipt?.eventId || null,
      ts: entry.ts || null,
      action: entry.action,
      status: reportActionStatus(entry),
      target: compactReportActionTarget(entry.target || null),
      evidence: compactReportActionEvidence(entry),
      receipt: receiptForReport(entry.receipt),
      nextHint: entry.nextHint || null,
    };
  }
  return {
    index,
    sequence: entry.sequence ?? index,
    eventId: entry.eventId || entry.receipt?.eventId || null,
    ts: entry.ts || null,
    action: entry.action,
    status: reportActionStatus(entry),
    outcome: entry.outcome || null,
    verdict: entry.verdict || null,
    target: entry.target || null,
    dispatch: entry.dispatch || null,
    settle: entry.settle || null,
    receipt: receiptForReport(entry.receipt),
    evidence: {
      dispatchMethod: entry.dispatch?.method || null,
      settleOk: entry.settle?.ok ?? null,
      settleDurationMs: entry.settle?.durationMs ?? null,
      effectSummary: entry.effectSummary || null,
      effectSample: entry.effectSample || null,
      consoleSummary: entry.consoleSummary || null,
      consoleSample: entry.consoleSample || null,
      exceptionSummary: entry.exceptionSummary || null,
      exceptionSample: entry.exceptionSample || null,
      networkSummary: entry.networkSummary || null,
      networkSample: entry.networkSample || null,
      failure: entry.failure || null,
      diagnosis: entry.diagnosis || null,
    },
    nextHint: entry.nextHint || null,
  };
}

function compactReportBudgetModel(reportBudget = {}) {
  return {
    jsonBytesMax: reportBudget.jsonBytesMax ?? DEFAULT_REPORT_JSON_BYTES_MAX,
    estimatedJsonBytes: null,
    actionLimit: reportBudget.actionLimit ?? null,
  };
}

function compactReportArtifactsSummary(artifacts = {}) {
  return {
    paths: artifacts.paths || {},
    counts: artifacts.counts || {},
  };
}

function compactReportEnvironmentModel(environment = {}) {
  return {
    networkThrottleSummary: environment.networkThrottleSummary || 'none',
    networkMocksSummary: environment.networkMocksSummary || 'none',
    clockSummary: environment.clockSummary || 'real time',
  };
}

function reportScreenshotModel(entry = {}, index = 0, { compact = false } = {}) {
  if (compact) {
    return {
      index: index + 1,
      path: entry.path || null,
      kind: entry.kind || 'shot',
    };
  }
  return {
    index: index + 1,
    ts: entry.ts || null,
    kind: entry.kind || 'shot',
    path: entry.path || null,
    note: entry.note || '',
  };
}

function parseReportArgs(args = []) {
  let lastActions = DEFAULT_REPORT_ACTION_LIMIT;
  let compact = false;
  let qa = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      lastActions = null;
    } else if (arg === '--compact') {
      compact = true;
    } else if (arg === '--qa' || arg === '--summary') {
      qa = true;
      compact = true;
    } else if (arg === '--last') {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error('report: --last requires a positive integer');
      lastActions = n;
    } else {
      rest.push(arg);
    }
  }
  return { lastActions, compact, qa, args: rest };
}

function reportActionTimelineWindow(actionLog = [], lastActions = DEFAULT_REPORT_ACTION_LIMIT) {
  const total = actionLog.length;
  const limit = lastActions == null ? null : Math.max(1, Math.floor(Number(lastActions) || DEFAULT_REPORT_ACTION_LIMIT));
  const startOffset = limit == null || total <= limit ? 0 : total - limit;
  const entries = actionLog.slice(startOffset);
  return {
    entries,
    total,
    shown: entries.length,
    omitted: startOffset,
    startIndex: entries.length ? startOffset + 1 : null,
    endIndex: entries.length ? total : null,
    limit,
    mode: limit == null ? 'all' : 'latest',
    expensive: limit == null,
  };
}

function buildSessionReportModel(session, { now = Date.now(), lastActions = DEFAULT_REPORT_ACTION_LIMIT, compact = false } = {}) {
  const actionLog = session.actionLog || [];
  const screenshots = session.screenshots || [];
  const timelineWindow = reportActionTimelineWindow(actionLog, lastActions);
  const uptimeMs = Math.max(0, now - (session.createdAt || now));
  const target = targetPrefixForDisplay(session.targetId);
  const artifacts = buildSessionArtifactsSummary(session);
  const reportBudget = buildReportBudget(timelineWindow);
  const cleanup = buildArtifactCleanupWorkflow(session);
  const actions = timelineWindow.entries.map((entry, offset) => {
    const index = (timelineWindow.startIndex || 1) + offset;
    return reportActionModel(entry, index, { compact });
  });
  const recommendation = buildReportRecommendation(actionLog, target, session.targetId);
  const nextSteps = uniqueNextStepCommands([
    ...(recommendation.commands || []),
    ...(actionLog.length > 0 ? [
      `cdp record-actions ${target} --format json`,
      `cdp export-playwright ${target}`,
    ] : []),
  ]);
  const environment = {
    networkThrottleSummary: formatThrottleSummary(session.networkThrottle),
    networkMocksSummary: formatNetworkMocksSummary(session),
    clockSummary: formatClockSummary(session.clock),
    controls: buildRecordEnvironmentModel(session),
  };
  const model = {
    schema: 'chrome-cdp-ex.report.v1',
    ...(compact ? { mode: 'compact' } : {}),
    targetId: session.targetId,
    targetPrefix: target,
    sessionId: session.sessionId,
    createdAt: session.createdAt || null,
    now,
    uptimeMs,
    paths: {
      log: session.logPath || null,
      screenshotDir: session.screenshotDir || null,
    },
    counts: {
      actions: actionLog.length,
      screenshots: screenshots.length,
      records: session.records?.length || 0,
    },
    artifacts: compact ? compactReportArtifactsSummary(artifacts) : artifacts,
    reportBudget: compact ? compactReportBudgetModel(reportBudget) : reportBudget,
    ...(!compact ? { cleanup } : {}),
    timelineWindow: {
      total: timelineWindow.total,
      shown: timelineWindow.shown,
      omitted: timelineWindow.omitted,
      startIndex: timelineWindow.startIndex,
      endIndex: timelineWindow.endIndex,
      limit: timelineWindow.limit,
      mode: timelineWindow.mode,
      expensive: timelineWindow.expensive,
    },
    latestAction: buildLatestReportActionSummary(actionLog),
    environment: compact ? compactReportEnvironmentModel(environment) : environment,
    actions,
    screenshots: screenshots.map((entry, index) => reportScreenshotModel(entry, index, { compact })),
    recommendation,
    nextSteps: nextSteps.length ? nextSteps : defaultReportNextSteps(target, actionLog.length > 0),
  };
  model.reportBudget.estimatedJsonBytes = Buffer.byteLength(formatJson(model), 'utf8');
  return model;
}

function formatSessionReport(session, { now = Date.now(), format = 'text', lastActions = DEFAULT_REPORT_ACTION_LIMIT, compact = false, qa = false } = {}) {
  if (qa) {
    const model = buildSessionReportModel(session, { now, lastActions, compact: true });
    const latest = model.latestAction || null;
    const summary = buildQaSummaryModel({
      page: { url: latest?.url || '', title: '' },
      console: {
        errors: Number(latest?.consoleErrors || latest?.effects?.consoleDelta?.errors || 0),
        exceptions: Number(latest?.exceptions || latest?.effects?.exceptionDelta?.count || 0),
      },
      network: {
        failures: Number(latest?.networkFailures || latest?.effects?.networkDelta?.failures || 0),
      },
      action: latest ? {
        outcome: latest.outcome || latest.receipt?.outcome || null,
        dispatch: { ok: latest.dispatchOk !== false },
        changed: latest.outcome ? latest.outcome !== 'no-change' : undefined,
      } : null,
      targetPrefix: model.targetPrefix,
      nextCommand: model.nextSteps?.[0] || null,
      source: 'report',
    });
    if (format === 'json') {
      return formatJson({
        ...summary,
        report: {
          schema: model.schema,
          targetPrefix: model.targetPrefix,
          counts: model.counts,
          latestAction: model.latestAction,
          nextSteps: model.nextSteps,
        },
      });
    }
    return formatQaSummaryText(summary);
  }
  if (format === 'json') return formatJson(buildSessionReportModel(session, { now, lastActions, compact }));
  const model = buildSessionReportModel(session, { now, lastActions });
  const actionLog = session.actionLog || [];
  const timelineWindow = reportActionTimelineWindow(actionLog, lastActions);
  const screenshots = session.screenshots || [];
  const uptimeMs = Math.max(0, now - (session.createdAt || now));
  const actionCountLine = timelineWindow.omitted > 0
    ? `Actions: ${actionLog.length} (showing last ${timelineWindow.shown}, ${timelineWindow.omitted} omitted)`
    : `Actions: ${actionLog.length}`;
  const lines = [
    `Session report: ${session.targetId}`,
    `CDP session: ${session.sessionId}`,
    `Uptime: ${formatDuration(uptimeMs)}`,
    `Log: ${session.logPath || '(disabled)'}`,
    `Screenshot dir: ${session.screenshotDir || '(disabled)'}`,
    actionCountLine,
    `Screenshots: ${screenshots.length}`,
    `Records: ${session.records?.length || 0}`,
    `Report JSON budget: ${formatBytes(model.reportBudget.estimatedJsonBytes)} / ${formatBytes(model.reportBudget.jsonBytesMax)}; ${model.reportBudget.warning}`,
    `Artifact bytes: log ${formatBytes(model.artifacts.sizes.log.sizeBytes)}, screenshots ${formatBytes(model.artifacts.sizes.screenshotDir.sizeBytes)} (${model.artifacts.sizes.screenshotDir.fileCount} files)`,
    `Cleanup: ${model.cleanup.workflow[0]}`,
    `Network throttle: ${formatThrottleSummary(session.networkThrottle)}`,
    `Network mocks: ${formatNetworkMocksSummary(session)}`,
    `Clock: ${formatClockSummary(session.clock)}`,
    '',
    'Action timeline:',
  ];
  if (actionLog.length === 0) {
    lines.push('No actions recorded yet. Run click/fill/press/nav/inject/reload, then report again.');
  } else {
    if (timelineWindow.omitted > 0) {
      lines.push(`Showing actions ${timelineWindow.startIndex}-${timelineWindow.endIndex}. Use report --all or inspect the JSONL log for the full action history.`);
    }
    for (const [offset, entry] of timelineWindow.entries.entries()) {
      const i = (timelineWindow.startIndex || 1) + offset;
      const label = entry.target?.label || entry.target?.input || '';
      const settleStatus = entry.dispatch?.ok === false ? 'failed' : (entry.settle?.ok ? 'ok' : 'not confirmed');
      const settleDuration = Number.isFinite(entry.settle?.durationMs) ? ` in ${entry.settle.durationMs}ms` : '';
      const sourceTarget = actionTargetCommandId(entry.target || {}) || session.targetId;
      lines.push(`${i}. ${entry.action}${label ? ` ${label}` : ''} — ${settleStatus}${settleDuration}`);
      if (entry.dispatch?.method) lines.push(`   Dispatch: ${entry.dispatch.method}`);
      if (entry.outcome?.status) lines.push(`   Outcome: ${entry.outcome.status}${entry.outcome.reason ? ` — ${entry.outcome.reason}` : ''}`);
      if (entry.verdict?.status) lines.push(`   Verdict: ${entry.verdict.status}${entry.verdict.reason ? ` — ${entry.verdict.reason}` : ''}`);
      if (entry.failure?.kind) lines.push(`   Failure: ${entry.failure.kind} — ${entry.failure.reason}`);
      if (entry.diagnosis?.kind && entry.diagnosis.status !== 'ok') {
        lines.push(`   Diagnosis: ${entry.diagnosis.kind} — ${entry.diagnosis.reason}`);
      }
      if (entry.diagnosis?.recovery?.strategy && entry.diagnosis.status !== 'ok') {
        lines.push(`   Recovery: ${entry.diagnosis.recovery.strategy}`);
      }
      if (entry.effectSummary) lines.push(`   Effect: ${entry.effectSummary}`);
      if (entry.effectSample) lines.push(`   Sample: ${entry.effectSample}`);
      if (entry.consoleSummary) lines.push(`   ${entry.consoleSummary}`);
      if (entry.consoleSample) lines.push(`   Console sample: ${entry.consoleSample}`);
      if (entry.exceptionSummary) lines.push(`   ${entry.exceptionSummary}`);
      if (entry.exceptionSample) lines.push(`   Exception sample: ${entry.exceptionSample}`);
      if (entry.networkSummary) lines.push(`   ${entry.networkSummary}`);
      if (entry.networkSample) lines.push(`   Network sample: ${entry.networkSample}`);
      if (entry.diagnosis?.nextCommand && entry.diagnosis.status !== 'ok') {
        lines.push(`   Diagnostic next: ${normalizeReportTargetCommand(entry.diagnosis.nextCommand, sourceTarget, model.targetPrefix)}`);
      }
      if (entry.nextHint) lines.push(`   Next: ${normalizeReportTargetCommand(entry.nextHint, sourceTarget, model.targetPrefix)}`);
    }
  }
  if (screenshots.length > 0) {
    lines.push('', 'Attachments:');
    for (const [i, entry] of screenshots.entries()) {
      const note = entry.note ? ` (${entry.note})` : '';
      lines.push(`${i + 1}. ${entry.kind || 'shot'} — ${entry.path}${note}`);
    }
  }
  lines.push('', ...formatReportRecommendationLines(model.recommendation));
  lines.push('', ...formatReportNextStepLines(model.nextSteps));
  return lines.join('\n');
}

function commandArgsFromTarget(entry, fallbackArgs = []) {
  const args = entry.target && Array.isArray(entry.target.commandArgs)
    ? entry.target.commandArgs
    : fallbackArgs;
  return args.filter(v => v !== undefined && v !== null).map(v => String(v));
}

function normalizeRecordCommandName(value = '') {
  const name = String(value || '').toLowerCase();
  if (name === 'diffshot') return 'diff-shot';
  if (name === 'dismissmodal') return 'dismiss-modal';
  return name;
}

function forcedRecordCommandNeedsInput(commandName, args = []) {
  const name = normalizeRecordCommandName(commandName);
  if (name === 'diff-shot') return ['live-visual-baseline'];
  if (name === 'upload') {
    if (args.includes('<redacted>') || args.length < 2) return ['file'];
  }
  return null;
}

function inferRecordActionCommand(entry) {
  const targetInput = entry.target?.input || '';
  const commandName = entry.target?.commandName || entry.action;
  const explicitArgs = entry.target && Array.isArray(entry.target.commandArgs);
  if (explicitArgs) {
    const args = commandArgsFromTarget(entry);
    const needsInput = forcedRecordCommandNeedsInput(commandName, args)
      || (args.includes('<redacted>') ? redactedCommandNeedsInput(commandName) : []);
    return { command: [commandName, ...args], replayable: needsInput.length === 0, needsInput };
  }

  switch (entry.action) {
    case 'click':
    case 'jsclick':
      return targetInput
        ? { command: [entry.action, targetInput], replayable: true, needsInput: [] }
        : { command: [entry.action, '<selector|@ref>'], replayable: false, needsInput: ['target'] };
    case 'clickxy': {
      const parts = targetInput.split(',').map(s => s.trim()).filter(Boolean);
      return parts.length >= 2
        ? { command: ['clickxy', parts[0], parts[1]], replayable: true, needsInput: [] }
        : { command: ['clickxy', '<x>', '<y>'], replayable: false, needsInput: ['coordinates'] };
    }
    case 'press':
    case 'scroll':
    case 'nav':
    case 'viewport':
      return targetInput
        ? { command: [entry.action, ...targetInput.split(/\s+/).filter(Boolean)], replayable: true, needsInput: [] }
        : { command: [entry.action, '<input>'], replayable: false, needsInput: ['input'] };
    case 'back':
    case 'forward':
    case 'reload':
    case 'dismiss-modal':
      return { command: [entry.action], replayable: true, needsInput: [] };
    case 'fill':
      return {
        command: ['fill', targetInput || '<selector|@ref>', '<text>'],
        replayable: false,
        needsInput: targetInput ? ['text'] : ['target', 'text'],
      };
    case 'select':
      return {
        command: ['select', targetInput || '<selector>', '<value>'],
        replayable: false,
        needsInput: targetInput ? ['value'] : ['target', 'value'],
      };
    case 'type':
      return { command: ['type', '<text>'], replayable: false, needsInput: ['text'] };
    case 'inject':
      return { command: ['inject', targetInput || '<type>', '<content>'], replayable: false, needsInput: ['content'] };
    case 'upload':
      return {
        command: ['upload', targetInput || '<selector>', '<file>'],
        replayable: false,
        needsInput: targetInput ? ['file'] : ['target', 'file'],
      };
    case 'diff-shot':
    case 'diffshot':
      return {
        command: ['diff-shot', targetInput || '<selector>'],
        replayable: false,
        needsInput: ['live-visual-baseline'],
      };
    default:
      return {
        command: targetInput ? [entry.action, targetInput] : [entry.action],
        replayable: false,
        needsInput: ['review'],
      };
  }
}

function redactedCommandNeedsInput(action) {
  if (action === 'fill' || action === 'type') return ['text'];
  if (action === 'select') return ['value'];
  if (action === 'inject') return ['content'];
  if (action === 'upload') return ['file'];
  return ['input'];
}

function mockEnvironmentCommand(entry = {}) {
  if (entry.action === 'clear') return ['mock', 'clear'];
  const rule = entry.rule || {};
  const command = ['mock', 'add', String(rule.urlPattern || '<urlPattern>'), '--status', String(rule.status ?? 200)];
  if (rule.body != null && rule.body !== '') command.push('--body', String(rule.body));
  if (rule.contentType) command.push('--content-type', String(rule.contentType));
  if (rule.method) command.push('--method', String(rule.method));
  return command;
}

function throttleEnvironmentCommand(entry = {}) {
  const throttle = entry.throttle || {};
  const profile = throttle.profile || 'off';
  if (profile === 'custom') {
    return [
      'throttle', 'custom',
      '--latency', String(throttle.latencyMs || 0),
      '--download', String(throttle.downloadKbps ?? 0),
      '--upload', String(throttle.uploadKbps ?? 0),
    ];
  }
  return ['throttle', profile];
}

function clockEnvironmentCommand(entry = {}) {
  if (entry.action === 'reset' || !entry.clock) return ['clock', 'reset'];
  const clock = entry.clock || {};
  if (clock.profile === 'freeze') return ['clock', 'freeze', '--at', new Date(clock.atMs).toISOString()];
  if (clock.profile === 'offset') return ['clock', 'offset', '--ms', String(clock.offsetMs || 0)];
  return ['clock', 'reset'];
}

function environmentCommandFromLogEntry(entry = {}) {
  switch (entry.kind || entry.type) {
    case 'mock':
      return mockEnvironmentCommand(entry);
    case 'throttle':
      return throttleEnvironmentCommand(entry);
    case 'clock':
      return clockEnvironmentCommand(entry);
    default:
      return [];
  }
}

function sanitizeEnvironmentDetails(entry = {}) {
  if ((entry.kind || entry.type) === 'mock' && entry.rule) {
    return {
      rule: {
        urlPattern: entry.rule.urlPattern,
        method: entry.rule.method || null,
        status: entry.rule.status,
        contentType: entry.rule.contentType,
        body: entry.rule.body || '',
      },
    };
  }
  if ((entry.kind || entry.type) === 'throttle' && entry.throttle) {
    return {
      throttle: {
        profile: entry.throttle.profile || 'off',
        offline: entry.throttle.offline === true,
        latencyMs: entry.throttle.latencyMs || 0,
        downloadKbps: entry.throttle.downloadKbps,
        uploadKbps: entry.throttle.uploadKbps,
      },
    };
  }
  if ((entry.kind || entry.type) === 'clock' && entry.clock) {
    return {
      clock: {
        profile: entry.clock.profile || 'real',
        atMs: entry.clock.atMs ?? null,
        offsetMs: entry.clock.offsetMs || 0,
      },
    };
  }
  return {};
}

function buildRecordEnvironmentModel(session) {
  return (session.environmentLog || []).map((entry, index) => {
    const command = environmentCommandFromLogEntry(entry);
    const type = entry.type || entry.kind || 'environment';
    return {
      index: index + 1,
      ts: entry.ts || null,
      type,
      action: entry.action || (type === 'throttle' ? 'apply' : 'set'),
      command,
      replayable: command.length > 0,
      needsInput: command.length > 0 ? [] : ['review'],
      ...sanitizeEnvironmentDetails(entry),
    };
  });
}

function buildRecordActionsModel(session) {
  const actions = (session.actionLog || []).map((entry, index) => {
    const inferred = inferRecordActionCommand(entry);
    const dispatchFailed = entry.dispatch?.ok === false;
    const needsInput = dispatchFailed
      ? [...new Set([...inferred.needsInput, 'successful-dispatch'])]
      : inferred.needsInput;
    return {
      index: index + 1,
      ts: entry.ts,
      action: entry.action,
      target: entry.target || null,
      command: inferred.command,
      replayable: dispatchFailed ? false : inferred.replayable,
      needsInput,
      evidence: {
        dispatchMethod: entry.dispatch?.method || null,
        settleOk: entry.settle?.ok ?? null,
        settleDurationMs: entry.settle?.durationMs ?? null,
        effectSummary: entry.effectSummary || null,
        effectSample: entry.effectSample || null,
        consoleSummary: entry.consoleSummary || null,
        consoleSample: entry.consoleSample || null,
        exceptionSummary: entry.exceptionSummary || null,
        exceptionSample: entry.exceptionSample || null,
        networkSummary: entry.networkSummary || null,
        networkSample: entry.networkSample || null,
        failure: entry.failure || null,
        diagnosis: entry.diagnosis || null,
        outcome: entry.outcome || null,
        verdict: entry.verdict || null,
        nextHint: entry.nextHint || null,
      },
    };
  });
  const environment = buildRecordEnvironmentModel(session);
  return {
    schema: 'chrome-cdp-ex.record-actions.v1',
    targetId: session.targetId,
    sessionId: session.sessionId,
    source: 'session-action-log',
    environmentCount: environment.length,
    environment,
    actionCount: actions.length,
    actions,
  };
}

function formatCommandLine(command) {
  return (command || []).map(arg => {
    const s = String(arg);
    return /^[^\s"']+$/.test(s) ? s : JSON.stringify(s);
  }).join(' ');
}

function formatRecordActions(session, { format = 'text' } = {}) {
  const model = buildRecordActionsModel(session);
  if (format === 'json') return formatJson(model);
  const lines = [
    `Recorded actions: ${model.actionCount}`,
    `Session: ${model.targetId}`,
    'Source: current daemon session action log',
  ];
  if (model.environment.length) {
    lines.push(`Environment controls: ${model.environmentCount}`);
    for (const entry of model.environment) {
      const status = entry.replayable ? 'replayable' : (entry.needsInput.length ? 'needs input' : 'review needed');
      lines.push(`Env ${entry.index}. ${formatCommandLine(entry.command)} — ${status}`);
      if (entry.needsInput.length) lines.push(`   Missing: ${entry.needsInput.join(', ')}`);
    }
  }
  if (model.actions.length === 0) {
    lines.push('No actions recorded yet. Run click/fill/press/nav/inject/reload, then record-actions again.');
    return lines.join('\n');
  }
  for (const step of model.actions) {
    const label = step.target?.label || step.target?.input || '';
    const status = step.replayable ? 'replayable' : (step.needsInput.length ? 'needs input' : 'review needed');
    lines.push(`${step.index}. ${step.action}${label ? ` ${label}` : ''} — ${status}`);
    lines.push(`   Replay: ${formatCommandLine(step.command)}`);
    if (step.needsInput.length) lines.push(`   Missing: ${step.needsInput.join(', ')}`);
    if (step.evidence.settleOk !== null) {
      const settle = step.evidence.settleOk ? 'ok' : 'not confirmed';
      const duration = Number.isFinite(step.evidence.settleDurationMs) ? ` in ${step.evidence.settleDurationMs}ms` : '';
      lines.push(`   Settle: ${settle}${duration}`);
    }
    if (step.evidence.effectSummary) lines.push(`   Evidence: ${step.evidence.effectSummary}`);
    if (step.evidence.effectSample) lines.push(`   Sample: ${step.evidence.effectSample}`);
    if (step.evidence.outcome?.status) lines.push(`   Outcome: ${step.evidence.outcome.status}`);
    if (step.evidence.verdict?.status) lines.push(`   Verdict: ${step.evidence.verdict.status}`);
    if (step.evidence.failure?.kind) lines.push(`   Failure: ${step.evidence.failure.kind}`);
    if (step.evidence.failure?.reason) lines.push(`   Reason: ${step.evidence.failure.reason}`);
    if (step.evidence.nextHint) lines.push(`   Next: ${step.evidence.nextHint}`);
    if (step.evidence.consoleSummary) lines.push(`   ${step.evidence.consoleSummary}`);
    if (step.evidence.consoleSample) lines.push(`   Console sample: ${step.evidence.consoleSample}`);
    if (step.evidence.exceptionSummary) lines.push(`   ${step.evidence.exceptionSummary}`);
    if (step.evidence.exceptionSample) lines.push(`   Exception sample: ${step.evidence.exceptionSample}`);
    if (step.evidence.networkSummary) lines.push(`   ${step.evidence.networkSummary}`);
    if (step.evidence.networkSample) lines.push(`   Network sample: ${step.evidence.networkSample}`);
  }
  return lines.join('\n');
}

function isPlaywrightPortableSelector(value) {
  const selector = String(value || '').trim();
  return selector && !selector.startsWith('@') && !selector.startsWith('<') && selector !== '<redacted>';
}

const PLAYWRIGHT_ASSERTION_TEXT_ROLES = new Set(['alert', 'status', 'statustext', 'statictext', 'heading']);

function cleanObservedTextForPlaywrightAssertion(text) {
  return String(text || '')
    .replace(/\s+@f?\d+(?::\d+)?\b.*$/u, '')
    .replace(/\s+\(-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?[×x]\d+(?:\.\d+)?.*$/u, '')
    .replace(/\s{2,}.*/u, '')
    .trim();
}

function observedTextAssertionFromEffectSample(sample) {
  const line = String(sample || '').trim();
  const match = line.match(/^\+\s+\[([^\]]+)\]\s+(.+)$/u);
  if (!match) return null;
  const role = match[1].replace(/\s+/g, '').toLowerCase();
  if (!PLAYWRIGHT_ASSERTION_TEXT_ROLES.has(role)) return null;
  const text = cleanObservedTextForPlaywrightAssertion(match[2]);
  if (!text || text.length < 2 || text.length > 160) return null;
  return text;
}

function playwrightAssertionLinesFromEvidence(evidence = {}) {
  const text = observedTextAssertionFromEffectSample(evidence.effectSample);
  if (!text) return [];
  return [`await expect(page.getByText(${JSON.stringify(text)})).toBeVisible();`];
}

function playwrightStepFromCommand(action = {}) {
  const command = Array.isArray(action.command) ? action.command.map(v => String(v)) : [];
  const commandText = command.length ? formatCommandLine(command) : `${action.action || 'action'} <missing command>`;
  const skip = (reason) => ({
    lines: [
      `// Not exported: ${commandText}`,
      `// Reason: ${reason}`,
    ],
    exported: false,
  });
  const finish = (lines) => ({
    lines: [...lines, ...playwrightAssertionLinesFromEvidence(action.evidence || {})],
    exported: true,
  });

  if (action.replayable !== true) {
    const missing = Array.isArray(action.needsInput) && action.needsInput.length
      ? action.needsInput.join(', ')
      : 'review';
    return skip(`not replayable; missing ${missing}`);
  }
  if (!command.length || !command[0]) return skip('missing command');
  if (command.includes('<redacted>')) return skip('redacted input');

  const [cmd, ...args] = command;
  switch (cmd) {
    case 'nav':
    case 'navigate':
      return args[0]
        ? finish([`await page.goto(${JSON.stringify(args[0])});`])
        : skip('missing URL');
    case 'click':
    case 'jsclick': {
      const selector = args[0] === '--js' || args[0] === '-j' ? args[1] : args[0];
      if (!isPlaywrightPortableSelector(selector)) return skip('needs stable selector; chrome-cdp-ex @refs are session-local');
      return finish([`await page.locator(${JSON.stringify(selector)}).click();`]);
    }
    case 'fill': {
      const usesReactFill = args[0] === '--react';
      const selector = usesReactFill ? args[1] : args[0];
      const text = usesReactFill ? args[2] : args[1];
      if (!isPlaywrightPortableSelector(selector)) return skip('needs stable selector; chrome-cdp-ex @refs are session-local');
      if (text == null || text === '<redacted>') return skip('missing fill text');
      return finish([`await page.locator(${JSON.stringify(selector)}).fill(${JSON.stringify(text)});`]);
    }
    case 'select': {
      const [selector, value] = args;
      if (!isPlaywrightPortableSelector(selector)) return skip('needs stable selector');
      if (value == null) return skip('missing select value');
      return finish([`await page.locator(${JSON.stringify(selector)}).selectOption(${JSON.stringify(value)});`]);
    }
    case 'type':
      return args[0]
        ? finish([`await page.keyboard.type(${JSON.stringify(args[0])});`])
        : skip('missing text');
    case 'press':
      return args[0]
        ? finish([`await page.keyboard.press(${JSON.stringify(args[0])});`])
        : skip('missing key');
    case 'clickxy': {
      const x = Number(args[0]);
      const y = Number(args[1]);
      return Number.isFinite(x) && Number.isFinite(y)
        ? finish([`await page.mouse.click(${x}, ${y});`, '// Coordinate click: review before committing as a regression test.'])
        : skip('missing coordinates');
    }
    case 'scroll': {
      const direction = args[0] || '';
      const amount = Number(args[1] || 500);
      const dirMap = { down: [0, amount], up: [0, -amount], left: [-amount, 0], right: [amount, 0] };
      let xy = dirMap[direction.toLowerCase()];
      if (!xy && direction.includes(',')) xy = direction.split(',').map(Number);
      return xy && xy.every(Number.isFinite)
        ? finish([`await page.mouse.wheel(${xy[0]}, ${xy[1]});`])
        : skip('unsupported scroll arguments');
    }
    case 'viewport': {
      const match = String(args[0] || '').match(/^(\d+)[x×](\d+)$/);
      return match
        ? finish([`await page.setViewportSize({ width: ${Number(match[1])}, height: ${Number(match[2])} });`])
        : skip('unsupported viewport format');
    }
    case 'reload':
      return finish(['await page.reload();']);
    case 'back':
      return finish(['await page.goBack();']);
    case 'forward':
      return finish(['await page.goForward();']);
    case 'dismiss-modal':
    case 'dismissmodal':
      return finish(['await page.keyboard.press("Escape");', '// Review: chrome-cdp-ex may have clicked a specific close button instead.']);
    default:
      return skip(`unsupported command: ${cmd}`);
  }
}

function parseFlagArgs(args = []) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (String(token || '').startsWith('--')) {
      opts[token] = args[++i];
    }
  }
  return opts;
}

function playwrightStepFromEnvironment(entry = {}) {
  const command = Array.isArray(entry.command) ? entry.command.map(v => String(v)) : [];
  const commandText = command.length ? formatCommandLine(command) : `${entry.type || 'environment'} <missing command>`;
  const skip = (reason) => ({
    lines: [
      `// Environment not exported: ${commandText}`,
      `// Reason: ${reason}`,
    ],
    exported: false,
  });

  if (!command.length || !command[0]) return skip('missing command');
  if (command.includes('<redacted>')) return skip('redacted input');
  const [cmd, mode, pattern, ...rest] = command;
  if (cmd === 'mock' && mode === 'add') {
    if (!pattern || pattern.startsWith('<')) return skip('missing URL pattern');
    const flags = parseFlagArgs(rest);
    const status = Number(flags['--status'] || 200);
    const contentType = flags['--content-type'] || 'text/plain; charset=utf-8';
    const body = flags['--body'] || '';
    const method = flags['--method'];
    if (method) {
      return {
        lines: [
          `await page.route(${JSON.stringify(pattern)}, route => {`,
          `  if (route.request().method() !== ${JSON.stringify(method)}) return route.continue();`,
          `  return route.fulfill({ status: ${Number.isFinite(status) ? status : 200}, contentType: ${JSON.stringify(contentType)}, body: ${JSON.stringify(body)} });`,
          '});',
        ],
        exported: true,
      };
    }
    return {
      lines: [
        `await page.route(${JSON.stringify(pattern)}, route => route.fulfill({ status: ${Number.isFinite(status) ? status : 200}, contentType: ${JSON.stringify(contentType)}, body: ${JSON.stringify(body)} }));`,
      ],
      exported: true,
    };
  }
  if (cmd === 'mock' && mode === 'clear') return skip('Playwright routes are test-scoped; review whether unroute is needed');
  if (cmd === 'throttle') return skip('chrome-cdp-ex live network throttling has no portable exporter step yet');
  if (cmd === 'clock') return skip('chrome-cdp-ex live clock override has no portable exporter step yet');
  return skip(`unsupported environment command: ${cmd}`);
}

function formatPlaywrightSpecFromRecordActions(model, { title = 'chrome-cdp-ex exported workflow' } = {}) {
  const actions = Array.isArray(model?.actions) ? model.actions : [];
  const environment = Array.isArray(model?.environment) ? model.environment : [];
  const environmentSteps = environment.map(entry => playwrightStepFromEnvironment(entry));
  const actionSteps = actions.map(action => playwrightStepFromCommand(action));
  const hasAssertions = actionSteps.some(step => step.lines.some(line => /\bexpect\(/.test(line)));
  const lines = [
    `import { test${hasAssertions ? ', expect' : ''} } from '@playwright/test';`,
    '',
    '// Generated from chrome-cdp-ex record-actions.',
    '// Review selectors, assertions, auth state, and skipped steps before committing.',
    '',
    `test(${singleQuotedJsString(title)}, async ({ page }) => {`,
  ];
  let environmentExported = 0;
  let environmentSkipped = 0;
  for (const step of environmentSteps) {
    if (step.exported) environmentExported++;
    else environmentSkipped++;
    for (const line of step.lines) lines.push(`  ${line}`);
  }
  let exported = 0;
  let skipped = 0;
  for (const step of actionSteps) {
    if (step.exported) exported++;
    else skipped++;
    for (const line of step.lines) lines.push(`  ${line}`);
  }
  if (actions.length === 0 && environment.length === 0) {
    lines.push('  // No recorded actions yet. Run click/fill/nav, then export-playwright again.');
  }
  lines.push('});');
  lines.push('');
  if (environment.length) {
    lines.push(`// Environment exported ${environmentExported}/${environment.length} step(s); ${environmentSkipped} need review.`);
  }
  lines.push(`// Exported ${exported}/${actions.length} step(s); ${skipped} need review.`);
  return lines.join('\n');
}

function parseExportPlaywrightArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = { title: 'chrome-cdp-ex exported workflow', format: fopts.format };
  for (let i = 0; i < fopts.args.length; i++) {
    if (fopts.args[i] === '--title') {
      opts.title = fopts.args[++i] || opts.title;
    }
  }
  return opts;
}

function singleQuotedJsString(value) {
  return `'${String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
}

function playwrightExportReviewEntry(phase, index, sourceEntry = {}, step = {}) {
  const command = Array.isArray(sourceEntry.command) ? sourceEntry.command.map(v => String(v)) : [];
  const reasonLine = (step.lines || []).find(line => line.startsWith('// Reason: '));
  return {
    phase,
    index,
    exported: step.exported === true,
    command,
    commandText: command.length ? formatCommandLine(command) : null,
    reason: reasonLine ? reasonLine.slice('// Reason: '.length) : null,
  };
}

function buildExportPlaywrightModel(recordActionsModel, opts = {}) {
  const actions = Array.isArray(recordActionsModel?.actions) ? recordActionsModel.actions : [];
  const environment = Array.isArray(recordActionsModel?.environment) ? recordActionsModel.environment : [];
  const environmentSteps = environment.map(entry => playwrightStepFromEnvironment(entry));
  const actionSteps = actions.map(action => playwrightStepFromCommand(action));
  const environmentExported = environmentSteps.filter(step => step.exported).length;
  const actionsExported = actionSteps.filter(step => step.exported).length;
  const assertions = actionSteps.reduce((count, step) => (
    count + (step.lines || []).filter(line => /\bexpect\(/.test(line)).length
  ), 0);
  const review = [
    ...environmentSteps.map((step, i) => playwrightExportReviewEntry('environment', i + 1, environment[i], step)),
    ...actionSteps.map((step, i) => playwrightExportReviewEntry('action', i + 1, actions[i], step)),
  ].filter(entry => !entry.exported);
  const targetId = recordActionsModel?.targetId || '<target>';
  const skipped = review.length;
  const nextSteps = skipped > 0
    ? [
        'Review skipped steps and auth state before committing the Playwright spec.',
        `cdp record-actions ${targetId} --format json`,
        `cdp report ${targetId} --format json`,
      ]
    : [
        'Review auth state and selectors before committing the Playwright spec.',
        `cdp report ${targetId} --format json`,
      ];

  return {
    schema: 'chrome-cdp-ex.export-playwright.v1',
    targetId: recordActionsModel?.targetId || null,
    sessionId: recordActionsModel?.sessionId || null,
    source: 'record-actions',
    title: opts.title || 'chrome-cdp-ex exported workflow',
    counts: {
      environment: environment.length,
      environmentExported,
      environmentSkipped: environment.length - environmentExported,
      actions: actions.length,
      actionsExported,
      actionsSkipped: actions.length - actionsExported,
      assertions,
    },
    spec: formatPlaywrightSpecFromRecordActions(recordActionsModel, opts),
    review,
    nextSteps,
  };
}

function formatExportPlaywright(session, opts = {}) {
  const model = buildRecordActionsModel(session);
  if (opts.format === 'json') return formatJson(buildExportPlaywrightModel(model, opts));
  return formatPlaywrightSpecFromRecordActions(model, opts);
}

function createSessionState({ targetId, sessionId, logPath = sessionLogPath(targetId), screenshotDir = sessionScreenshotDir(targetId) }) {
  return {
    targetId,
    sessionId,
    createdAt: Date.now(),
    logPath,
    screenshotDir,
    logErrors: [],
    pageGeneration: 0,
    refGeneration: 0,
    refs: {
      map: new Map(),
      generation: 0,
      lastPerceiveAt: 0,
      invalidatedAt: Date.now(),
      invalidationReason: 'daemon-start',
    },
    lastPerceive: { output: null, model: null },
    lastAction: null,
    buffers: {},
    pendingRequests: new Map(),
    networkThrottle: null,
    networkMocks: [],
    networkMockHits: [],
    clock: null,
    environmentLog: [],
    actionSeq: 0,
    actionLog: [],
    screenshots: [],
    diffShot: null,
    records: [],
    frames: [],
    injections: [],
    privacy: {
      redactCookies: true,
      redactStorage: true,
      redactAuthorizationHeaders: true,
    },
  };
}

function invalidateSessionRefs(session, reason) {
  session.refs.map.clear();
  if (session.refs.frameRefs instanceof Map) session.refs.frameRefs.clear();
  if (session.refs.frameLastOutputs instanceof Map) session.refs.frameLastOutputs.clear();
  session.refs.invalidatedAt = Date.now();
  session.refs.invalidationReason = reason;
  session.refGeneration += 1;
}

// Roles that get visual layout annotations in perceive output
const ENRICHED_ROLES = new Set([
  'banner', 'navigation', 'main', 'contentinfo', 'complementary',
  'heading', 'img', 'image', 'video', 'form', 'table', 'dialog',
  'region', 'article', 'alert',
]);

// Roles that get @ref indices in perceive output (interactive elements)
const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'menuitem', 'tab', 'checkbox', 'radio', 'switch',
  'textbox', 'searchbox', 'combobox', 'spinbutton', 'slider',
  'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
]);

// Format a stale/unknown @ref error explaining the most likely root cause.
// `state` holds {generation, invalidationReason, lastPerceiveAt} from the daemon.
function formatUnknownRefError(ref, state = {}) {
  const reason = state.invalidationReason || (state.generation ? null : 'daemon-start');
  if (reason === 'navigation') {
    return `Unknown ref: ${ref}. Refs were cleared because the page navigated/reloaded after the last perceive (e.g. Vite HMR or in-app routing). Run "perceive" to refresh refs, or use a stable CSS selector for long loops.`;
  }
  if (reason === 'dom-mutation') {
    return `Unknown ref: ${ref}. Refs were invalidated by DOM changes after the last perceive. Run "perceive" again, or use a stable CSS selector in batch/loops.`;
  }
  if (reason === 'daemon-start' || (!state.generation)) {
    return `Unknown ref: ${ref}. No refs have been assigned in this daemon yet. Run "perceive" first, or use a CSS selector.`;
  }
  return `Unknown ref: ${ref}. Run "perceive" to refresh refs, or use a stable CSS selector for long loops.`;
}

async function resolveRefNode(cdp, sid, refMap, ref, refState) {
  const frameParsed = parseFrameRef(ref);
  let num = null;
  let frameEntry = null;
  let backendNodeId;
  if (frameParsed) {
    const scoped = frameScopedBackendNode(refState || {}, frameParsed);
    frameEntry = scoped.entry;
    backendNodeId = scoped.backendNodeId;
  } else {
    num = parseInt(ref.slice(1));
    if (isNaN(num) || !refMap.has(num)) {
      throw new Error(formatUnknownRefError(ref, refState || {}));
    }
    backendNodeId = refMap.get(num);
  }
  try {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId }, sid, REF_RESOLVE_TIMEOUT);
    return object.objectId;
  } catch (e) {
    // The ref existed in this daemon, but the backend node can no longer be
    // resolved. That is the common "DOM rewrote the element after perceive"
    // stale-ref case; classify it distinctly instead of surfacing raw CDP text.
    if (refState) {
      refState.invalidatedAt = Date.now();
      refState.invalidationReason = 'dom-mutation';
    }
    if (frameParsed) frameEntry?.refs?.delete(frameParsed.refIndex);
    else refMap.delete(num);
    throw new Error(formatUnknownRefError(ref, refState || {}) + ` Original CDP error: ${e.message}`);
  }
}

function scrollSettledRectFunctionDeclaration() {
  return `async function() {
    const readRect = () => {
      const rect = this.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    };
    const initial = readRect();
    const fullyVisible = initial.x >= 0 && initial.y >= 0 &&
      initial.x + initial.w <= window.innerWidth && initial.y + initial.h <= window.innerHeight;
    if (!fullyVisible) this.scrollIntoView({ block: 'center', inline: 'center' });
    const maxSamples = 12;
    let previous = readRect();
    let stableSamples = 0;
    for (let sample = 0; sample < maxSamples; sample++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const current = readRect();
      const movement = Math.max(
        Math.abs(current.x - previous.x),
        Math.abs(current.y - previous.y),
        Math.abs(current.w - previous.w),
        Math.abs(current.h - previous.h),
      );
      previous = current;
      stableSamples = movement < 0.5 ? stableSamples + 1 : 0;
      if (stableSamples >= 1) break;
    }
    return {
      ...previous,
      tag: this.tagName,
      text: (this.textContent || '').trim().substring(0, 80),
    };
  }`;
}

async function resolveRef(cdp, sid, refMap, ref, refState) {
  const frameParsed = parseFrameRef(ref);
  const objectId = await resolveRefNode(cdp, sid, refMap, ref, refState);
  const result = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: scrollSettledRectFunctionDeclaration(),
    returnByValue: true,
    awaitPromise: true,
  }, sid);
  const value = result.result.value || {};
  if (frameParsed) {
    const { entry } = frameScopedBackendNode(refState || {}, frameParsed);
    const offset = await frameViewportOffset(cdp, sid, entry);
    value.x = (Number(value.x) || 0) + offset.x;
    value.y = (Number(value.y) || 0) + offset.y;
  }
  return value;
}

function isRef(s) { return /^@\d+$/.test(s) || /^@f\d+:\d+$/.test(s); }
function isCursorRef(s) { return /^@c\d+$/.test(String(s || '')); }

function resolveCursorRef(refMap, ref, refState) {
  const key = String(ref || '').slice(1);
  const entry = refMap.get(key);
  if (!entry) {
    throw new Error(`Unknown cursor ref: ${ref}. Run "perceive -C -d 8" to refresh cursor refs, or use a stable CSS selector.${refState?.invalidationReason ? ` Ref state: ${refState.invalidationReason}.` : ''}`);
  }
  const x = Number(entry.x);
  const y = Number(entry.y);
  const w = Number(entry.w);
  const h = Number(entry.h);
  if (![x, y, w, h].every(Number.isFinite)) {
    throw new Error(`Invalid cursor ref: ${ref}. Run "perceive -C -d 8" to refresh cursor refs, or use a stable CSS selector.`);
  }
  return {
    x,
    y,
    w,
    h,
    sel: entry.sel || 'cursor-ref',
    text: String(entry.text || '').trim().substring(0, 80),
  };
}

function parseFrameOnlyRef(s) {
  const m = String(s || '').match(/^@f(\d+)$/);
  if (!m) return null;
  const frameIndex = Number(m[1]);
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 1) return null;
  return { frameRef: `@f${frameIndex}`, frameIndex };
}

function parseFrameRef(s) {
  const m = String(s || '').match(/^@f(\d+):(\d+)$/);
  if (!m) return null;
  const frameIndex = Number(m[1]);
  const refIndex = Number(m[2]);
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 1 || !Number.isSafeInteger(refIndex) || refIndex < 1) return null;
  return {
    frameRef: `@f${frameIndex}`,
    frameIndex,
    ref: `@${refIndex}`,
    refIndex,
  };
}

function flattenFrameTree(frameTree, { startIndex = 1 } = {}) {
  const frames = [];
  function visit(node, depth = 0, parentRef = null) {
    if (!node?.frame) return;
    const ref = `@f${startIndex + frames.length}`;
    const frame = node.frame;
    frames.push({
      ref,
      index: startIndex + frames.length,
      id: frame.id || '',
      parentId: frame.parentId || null,
      parentRef,
      depth,
      name: frame.name || '',
      url: frame.url || '',
      securityOrigin: frame.securityOrigin || '',
      unreachableUrl: frame.unreachableUrl || '',
      mimeType: frame.mimeType || '',
    });
    for (const child of node.childFrames || []) visit(child, depth + 1, ref);
  }
  visit(frameTree);
  return frames;
}

function formatFrameTreeText(frames = []) {
  const lines = [`Frames: ${frames.length}`];
  if (frames.length === 0) {
    lines.push('No frames reported by Page.getFrameTree.');
    return lines.join('\n');
  }
  for (const frame of frames) {
    const indent = '  '.repeat(Math.min(frame.depth || 0, 8));
    const label = frame.name || '(anonymous)';
    const parent = frame.parentRef ? ` parent:${frame.parentRef}` : '';
    const origin = frame.securityOrigin ? ` origin:${frame.securityOrigin}` : '';
    const url = frame.url || frame.unreachableUrl || '(no url)';
    lines.push(`${indent}${frame.ref} ${label} ${frame.id}${parent} ${url}${origin}`);
  }
  lines.push('Hint: use frame refs to diagnose wrong-frame errors; element refs inside frames will use @fN:M syntax.');
  return lines.join('\n');
}

async function framesModel(cdp, sid) {
  const result = await cdp.send('Page.getFrameTree', {}, sid);
  const frames = flattenFrameTree(result.frameTree);
  return {
    schema: 'chrome-cdp-ex.frames.v1',
    frameCount: frames.length,
    frames,
  };
}

async function framesStr(cdp, sid, { format = 'text' } = {}) {
  const model = await framesModel(cdp, sid);
  if (format === 'json') return formatJson(model);
  return formatFrameTreeText(model.frames);
}

async function resolveFrameRef(cdp, sid, frameRef) {
  const parsed = parseFrameOnlyRef(frameRef);
  if (!parsed) throw new Error(`Frame ref required (example: @f2), got: ${frameRef || '(empty)'}`);
  const model = await framesModel(cdp, sid);
  const frame = model.frames[parsed.frameIndex - 1];
  if (!frame || frame.ref !== parsed.frameRef) {
    throw new Error(`Unknown frame: ${parsed.frameRef}. Run "frame" to refresh the frame tree, then use a listed @fN ref.`);
  }
  return { frame, frames: model.frames };
}

async function createFrameExecutionContext(cdp, sid, frameId) {
  const res = await cdp.send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'chrome-cdp-ex',
    grantUniveralAccess: false,
  }, sid);
  return res.executionContextId;
}

function storeFrameScopedRefs(refState, frame, frames, scopedRefMap) {
  if (!refState || !frame) return;
  if (!(refState.frameRefs instanceof Map)) refState.frameRefs = new Map();
  refState.frameRefs.set(frame.ref, {
    frameRef: frame.ref,
    frameIndex: frame.index,
    frameId: frame.id,
    parentId: frame.parentId || null,
    parentRef: frame.parentRef || null,
    name: frame.name || '',
    url: frame.url || '',
    refs: new Map(scopedRefMap),
    frames: frames || [],
  });
}

function frameScopedRefEntry(refState, parsed) {
  const store = refState?.frameRefs;
  if (!(store instanceof Map)) return null;
  return store.get(parsed.frameRef) || null;
}

function frameScopedBackendNode(refState, parsed) {
  const entry = frameScopedRefEntry(refState, parsed);
  if (!entry) {
    throw new Error(`Unknown frame ref: ${parsed.frameRef}. Run "frame", then "perceive --frame ${parsed.frameRef}" to assign iframe-local refs.`);
  }
  if (!(entry.refs instanceof Map) || !entry.refs.has(parsed.refIndex)) {
    throw new Error(`Unknown ref: ${parsed.frameRef}:${parsed.refIndex}. Run "perceive --frame ${parsed.frameRef}" to refresh refs inside that frame.`);
  }
  return { entry, backendNodeId: entry.refs.get(parsed.refIndex) };
}

function qualifyFrameRefsInLines(lines, frameRef) {
  return lines.map(line => line.replace(/@(\d+)(?=\s*(?:\(|$))/, `${frameRef}:$1`));
}

function frameRefFromActionTarget(target = {}) {
  for (const value of [target.input, target.label, target.selector]) {
    const parsed = parseFrameRef(value);
    if (parsed) return parsed.frameRef;
  }
  return null;
}

function rememberFramePerceiveOutput(refState, frameRef, output) {
  if (!refState || !frameRef) return;
  if (!(refState.frameLastOutputs instanceof Map)) refState.frameLastOutputs = new Map();
  refState.frameLastOutputs.set(frameRef, output);
}

function baselineOutputForActionTarget(refState, fallbackOutput, target = {}) {
  const targetFrameRef = frameRefFromActionTarget(target);
  if (targetFrameRef && refState?.frameLastOutputs instanceof Map && refState.frameLastOutputs.has(targetFrameRef)) {
    return refState.frameLastOutputs.get(targetFrameRef);
  }
  return fallbackOutput;
}

async function frameViewportOffset(cdp, sid, frameEntry) {
  if (!frameEntry?.frameId || !frameEntry.parentId) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  let current = frameEntry;
  for (let guard = 0; current?.frameId && current.parentId && guard < 8; guard++) {
    const owner = await cdp.send('DOM.getFrameOwner', { frameId: current.frameId }, sid);
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: owner.backendNodeId }, sid);
    const res = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        const r = this.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }`,
      returnByValue: true,
    }, sid);
    const rect = res.result.value || {};
    x += Number(rect.x) || 0;
    y += Number(rect.y) || 0;
    const parent = (current.frames || []).find(frame => frame.id === current.parentId);
    if (!parent) break;
    current = {
      ...parent,
      frameRef: parent.ref,
      frameId: parent.id,
      frames: current.frames || [],
    };
  }
  return { x, y };
}

async function resolveRefRectNoScroll(cdp, sid, refMap, ref, refState) {
  const frameParsed = parseFrameRef(ref);
  const objectId = await resolveRefNode(cdp, sid, refMap, ref, refState);
  const result = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() {
      const rect = this.getBoundingClientRect();
      const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(this) : null;
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        tag: this.tagName,
        text: (this.textContent || '').trim().substring(0, 80),
        position: cs ? cs.position : '',
        pointerEvents: cs ? cs.pointerEvents : '',
        visible: !!(rect.width && rect.height),
      };
    }`,
    returnByValue: true,
  }, sid);
  const value = result.result.value || {};
  if (frameParsed) {
    const { entry } = frameScopedBackendNode(refState || {}, frameParsed);
    const offset = await frameViewportOffset(cdp, sid, entry);
    value.x = (Number(value.x) || 0) + offset.x;
    value.y = (Number(value.y) || 0) + offset.y;
  }
  return value;
}

// Wait for DOM mutations to stop after an action (350ms of silence = settled)
async function waitForSettle(cdp, sid, timeoutMs = 3000) {
  await evalStr(cdp, sid, `new Promise(resolve => {
    let timer;
    const done = () => { obs.disconnect(); resolve(); };
    const reset = () => { clearTimeout(timer); timer = setTimeout(done, 350); };
    const obs = new MutationObserver(reset);
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });
    timer = setTimeout(done, 350);
    setTimeout(() => { clearTimeout(timer); obs.disconnect(); resolve(); }, ${timeoutMs});
  })`);
}

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http/https URLs allowed, got: ${parsed.protocol}`);
  }
  // Block cloud metadata endpoints (AWS/GCP/Azure IMDS)
  const host = parsed.hostname;
  const metadataIPs = ['169.254.169.254', '169.254.170.2', 'fd00:ec2::254'];
  const metadataHosts = ['metadata.google.internal', 'metadata.gke.internal'];
  if (metadataIPs.includes(host) || metadataHosts.includes(host)) {
    throw new Error(`Blocked: cloud metadata endpoint (${host})`);
  }
  // Block link-local range (169.254.x.x)
  if (/^169\.254\.\d+\.\d+$/.test(host)) {
    throw new Error(`Blocked: link-local address (${host})`);
  }
}

// Perceive: enriched accessibility tree with inline visual layout annotations
// Options parsed from args: --diff, --selector <sel>, --interactive/-i, --depth <N>, --cursor-interactive/-C
function parsePerceiveArgs(args) {
  const opts = {
    diff: false, selector: null, exclude: null,
    interactive: false, maxDepth: Infinity, cursorInteractive: false,
    keepRefs: false, last: null, adaptive: false, sinceAction: false, frameRef: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--diff') opts.diff = true;
    else if (a === '--since-action') opts.sinceAction = true;
    else if (a === '-F' || a === '--frame') opts.frameRef = args[++i] || null;
    else if (a === '-s' || a === '--selector') opts.selector = args[++i];
    else if (a === '-x' || a === '--exclude') opts.exclude = args[++i];
    else if (a === '-i' || a === '--interactive') opts.interactive = true;
    else if (a === '-d' || a === '--depth') opts.maxDepth = parseInt(args[++i]) || Infinity;
    else if (a === '-C' || a === '--cursor-interactive') opts.cursorInteractive = true;
    else if (a === '--keep-refs') opts.keepRefs = true;
    else if (a === '--adaptive') opts.adaptive = true;
    else if (a === '--last') {
      const raw = args[++i];
      if (raw === 'auto') {
        opts.last = 'auto';
        opts.adaptive = true;
      } else {
        const n = parseInt(raw);
        opts.last = Number.isFinite(n) && n > 0 ? n : null;
      }
    }
  }
  return opts;
}

/**
 * Choose a perceive text-row budget from density + error state.
 * Explicit numeric --last still wins; this is for --adaptive / --last auto.
 */
function chooseAdaptivePerceiveLast({
  lineCount = 0,
  consoleErrors = 0,
  interactiveCount = 0,
  hasPriorityText = false,
} = {}) {
  let budget = 48;
  if (lineCount > 100) budget = 36;
  if (lineCount > 220) budget = 24;
  if (lineCount > 400) budget = 16;
  if (consoleErrors > 0 || hasPriorityText) budget = Math.max(budget, 28);
  if (interactiveCount > 40) budget = Math.min(budget, 22);
  if (interactiveCount > 80) budget = Math.min(budget, 16);
  return Math.max(8, Math.min(80, budget));
}

function parseControlsArgs(args) {
  const opts = { selector: null, filter: null, limit: 30, compact: false };
  const requireValue = (flag, label, index) => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`controls: ${flag} requires ${label}`);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-s' || a === '--selector' || a === '--scope') {
      opts.selector = requireValue(a, 'a CSS selector', i);
      i++;
    } else if (a === '--filter' || a === '-f') {
      opts.filter = requireValue(a, 'text', i);
      i++;
    } else if (a === '--limit' || a === '-n') {
      const raw = requireValue(a, 'a positive integer', i);
      i++;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`controls: ${a} requires a positive integer`);
      opts.limit = Math.min(n, 100);
    } else if (a === '--compact' || a === '--summary') {
      opts.compact = true;
    } else {
      throw new Error(`controls: unknown argument ${a}`);
    }
  }
  return opts;
}

function compactVisibleControlsModel(model = {}) {
  return {
    ...model,
    compact: true,
    controls: (model.controls || []).map(control => ({
      role: control.role || null,
      label: control.label || null,
      selector: control.selector || null,
      disabled: Boolean(control.disabled),
      clickable: Boolean(control.clickable),
      rect: control.rect || null,
    })),
  };
}

function visibleControlsCollectorSource() {
  return String.raw`
      function chromeCdpVisibleControls(options) {
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        const limit = Math.max(1, Math.min(Number(options.limit) || 30, 100));
        const scope = options.selector || null;
        const filter = options.filter ? String(options.filter).toLowerCase() : null;
        const schema = 'chrome-cdp-ex.visible-controls.v1';
        let root = document;
        if (scope) {
          try {
            root = document.querySelector(scope);
          } catch (err) {
            return { schema, scope, filter: options.filter || null, limit, total: 0, returned: 0, truncated: false, controls: [], error: 'invalid-selector', message: String(err && err.message || err || 'Invalid selector') };
          }
        }
        if (!root) {
          return { schema, scope, filter: options.filter || null, limit, total: 0, returned: 0, truncated: false, controls: [], error: 'scope-not-found' };
        }

        const interactiveRoles = new Set(['button', 'link', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'tab', 'textbox', 'combobox', 'searchbox']);
        const nativeInteractive = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
        const selector = [
          'a', 'button', 'input', 'select', 'textarea', 'summary',
          '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="option"]',
          '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="tab"]',
          '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]',
          '[role]', '[contenteditable="true"]', '[onclick]', '[tabindex]',
          '[aria-label]', '[title]',
          'div', 'span', 'li', 'label', 'svg', 'img'
        ].join(',');

        function esc(value) {
          const text = String(value || '');
          return window.CSS && CSS.escape ? CSS.escape(text) : text.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        }

        function compactText(value, max = 60) {
          return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
        }

        function roleFor(el) {
          const explicit = el.getAttribute('role');
          if (explicit) {
            const tokens = String(explicit).trim().toLowerCase().split(/\s+/).filter(Boolean);
            return tokens.find(token => interactiveRoles.has(token)) || tokens[0] || '';
          }
          const tag = el.tagName.toLowerCase();
          if (tag === 'a') return 'link';
          if (tag === 'button') return 'button';
          if (tag === 'textarea') return 'textbox';
          if (tag === 'select') return 'combobox';
          if (tag === 'input') {
            const type = String(el.getAttribute('type') || 'text').toLowerCase();
            if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
            if (['checkbox', 'radio'].includes(type)) return type;
            return 'textbox';
          }
          return '';
        }

        function selectorFor(el) {
          const tag = el.tagName.toLowerCase();
          if (el.id) return tag + '#' + esc(el.id);
          const aria = el.getAttribute('aria-label');
          if (aria) return tag + '[aria-label="' + String(aria).replace(/"/g, '\\"') + '"]';
          const title = el.getAttribute('title');
          if (title) return tag + '[title="' + String(title).replace(/"/g, '\\"') + '"]';
          if (typeof el.className === 'string' && el.className.trim()) {
            return tag + el.className.trim().split(/\s+/).slice(0, 2).map(c => '.' + esc(c)).join('');
          }
          return tag;
        }

        function isVisible(rect, cs) {
          if (!rect || rect.width < 4 || rect.height < 4) return false;
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
          return rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw;
        }

        function isClickable(el, cs, role) {
          const tagInteractive = nativeInteractive.has(el.tagName);
          const roleInteractive = interactiveRoles.has(role);
          return tagInteractive || roleInteractive || cs.cursor === 'pointer' || el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0);
        }

        const controls = [];
        const seen = new Set();
        const candidates = [];
        if (root.matches && root.matches(selector)) candidates.push(root);
        if (root.querySelectorAll) candidates.push(...root.querySelectorAll(selector));
        for (const el of candidates) {
          const cs = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (!isVisible(rect, cs)) continue;
          const role = roleFor(el);
          const clickable = isClickable(el, cs, role);
          const ariaLabel = compactText(el.getAttribute('aria-label'));
          const title = compactText(el.getAttribute('title'));
          const text = compactText(el.innerText || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value'));
          const label = ariaLabel || title || text || role || el.tagName.toLowerCase();
          if (!clickable && !ariaLabel && !title) continue;
          const path = selectorFor(el);
          const key = path + '|' + Math.round(rect.left) + ',' + Math.round(rect.top);
          if (seen.has(key)) continue;
          seen.add(key);
          const haystack = [el.tagName, role, ariaLabel, title, text, path, el.id, el.className].join(' ').toLowerCase();
          if (filter && !haystack.includes(filter)) continue;
          const classes = typeof el.className === 'string'
            ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3)
            : [];
          controls.push({
            tag: el.tagName.toLowerCase(),
            role,
            ariaLabel,
            title,
            label,
            text,
            disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
            clickable,
            rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
            selector: path,
            hints: { id: el.id || '', classes },
          });
        }
        const total = controls.length;
        return {
          schema,
          scope,
          filter: options.filter || null,
          limit,
          total,
          returned: Math.min(total, limit),
          truncated: total > limit,
          controls: controls.slice(0, limit),
        };
      }
  `;
}

function visibleControlsPageScript(opts = {}) {
  const options = {
    selector: opts.selector || null,
    filter: opts.filter || null,
    limit: opts.limit || 30,
  };
  return `(function() {
${visibleControlsCollectorSource()}
      return JSON.stringify(chromeCdpVisibleControls(${JSON.stringify(options)}));
    })()`;
}

function formatVisibleControlLine(control, index = null) {
  const role = control.role ? ` role=${control.role}` : '';
  const aria = control.ariaLabel ? ` aria-label="${control.ariaLabel}"` : '';
  const title = control.title && control.title !== control.label ? ` title="${control.title}"` : '';
  const label = control.label ? ` "${control.label}"` : '';
  const state = [
    control.clickable ? 'clickable' : null,
    control.disabled ? 'disabled' : null,
  ].filter(Boolean);
  const stateText = state.length ? ` [${state.join(',')}]` : '';
  const rect = control.rect ? ` (${control.rect.x},${control.rect.y} ${control.rect.w}×${control.rect.h})` : '';
  const hints = [];
  if (control.hints?.id) hints.push(`#${control.hints.id}`);
  for (const cls of control.hints?.classes || []) hints.push(`.${cls}`);
  const hintText = hints.length ? ` ${hints.join('')}` : '';
  const prefix = index == null ? '' : `${index}. `;
  return `${prefix}${control.tag || '?'}${role}${aria}${title}${label}${stateText}${rect} ${control.selector || ''}${hintText}`.trimEnd();
}

function formatVisibleControlsText(model) {
  if (model.error === 'scope-not-found') {
    return `Visible controls: scope not found (${model.scope})`;
  }
  const scope = model.scope ? ` in ${model.scope}` : '';
  const filter = model.filter ? ` matching "${model.filter}"` : '';
  const suffix = model.truncated ? ` (truncated to ${model.limit})` : '';
  const lines = [`Visible controls: ${model.returned}/${model.total}${scope}${filter}${suffix}`];
  if (!model.controls?.length) {
    lines.push('  none');
    return lines.join('\n');
  }
  model.controls.forEach((control, index) => {
    lines.push(`  ${formatVisibleControlLine(control, index + 1)}`);
  });
  return lines.join('\n');
}

async function controlsStr(cdp, sid, opts = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: visibleControlsPageScript(opts),
    returnByValue: true,
    awaitPromise: false,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  }
  const raw = result.result?.value ?? '{}';
  const model = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (model.error === 'invalid-selector') {
    throw new Error(`controls: invalid selector: ${model.scope}${model.message ? ` (${model.message})` : ''}`);
  }
  if (model.error === 'scope-not-found') {
    throw new Error(`controls: selector not found: ${model.scope}`);
  }
  const outputModel = opts.compact ? compactVisibleControlsModel(model) : model;
  return opts.format === 'json' ? formatJson(outputModel) : formatVisibleControlsText(outputModel);
}

function collectDomBackendNodeIds(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  const backendNodeId = node.backendNodeId ?? node.backendDOMNodeId;
  if (backendNodeId != null) out.add(backendNodeId);
  for (const key of ['children', 'shadowRoots', 'pseudoElements', 'distributedNodes']) {
    for (const child of node[key] || []) collectDomBackendNodeIds(child, out);
  }
  if (node.contentDocument) collectDomBackendNodeIds(node.contentDocument, out);
  if (node.templateContent) collectDomBackendNodeIds(node.templateContent, out);
  return out;
}

function filterAxNodesToBackendSubtree(axNodes, backendNodeIds) {
  if (!backendNodeIds || backendNodeIds.size === 0) return axNodes;
  const nodesById = new Map(axNodes.map(n => [n.nodeId, n]));
  const includeCache = new Map();
  function included(node) {
    if (!node) return false;
    if (includeCache.has(node.nodeId)) return includeCache.get(node.nodeId);
    let value = false;
    if (node.backendDOMNodeId != null && backendNodeIds.has(node.backendDOMNodeId)) {
      value = true;
    } else if (node.parentId) {
      value = included(nodesById.get(node.parentId));
    }
    includeCache.set(node.nodeId, value);
    return value;
  }
  return axNodes.filter(included);
}

function parsePerceiveHeader(output) {
  const lines = String(output || '').split('\n');
  const pageMatch = (lines[0] || '').match(/^Page: (.*) — (.*)$/);
  const viewportMatch = (lines[1] || '').match(/^Viewport: (\d+)×(\d+) \| Scroll: (\d+)\/(\d+)/);
  const consoleLine = lines.find(line => line.startsWith('Console: ')) || 'Console: clean';
  const consoleHealth = { errors: 0, warnings: 0, exceptions: 0 };
  for (const [key, pattern] of [
    ['errors', /(\d+) errors?/],
    ['warnings', /(\d+) warnings?/],
    ['exceptions', /(\d+) exceptions?/],
  ]) {
    const match = consoleLine.match(pattern);
    if (match) consoleHealth[key] = Number(match[1]);
  }
  return {
    page: {
      title: pageMatch ? pageMatch[1] : '',
      url: pageMatch ? pageMatch[2] : '',
    },
    viewport: {
      width: viewportMatch ? Number(viewportMatch[1]) : 0,
      height: viewportMatch ? Number(viewportMatch[2]) : 0,
      scrollY: viewportMatch ? Number(viewportMatch[3]) : 0,
      scrollMax: viewportMatch ? Number(viewportMatch[4]) : 0,
      coordinateSpace: 'viewport-css-px',
    },
    console: consoleHealth,
  };
}

function computePerceiveDiff(previousOutput, currentOutput) {
  const prev = previousOutput.split('\n');
  const curr = currentOutput.split('\n');
  // Skip header lines up to the first blank line. Frame-scoped perceive adds
  // a `Frame:` header, so avoid hard-coding the legacy 5-line header shape.
  const prevHeaderEnd = prev.findIndex(line => line === '');
  const currHeaderEnd = curr.findIndex(line => line === '');
  const prevTreeStart = prevHeaderEnd >= 0 ? prevHeaderEnd + 1 : 5;
  const currTreeStart = currHeaderEnd >= 0 ? currHeaderEnd + 1 : 5;
  const prevTree = prev.slice(prevTreeStart);
  const currTree = curr.slice(currTreeStart);
  // Line-level diff with StaticText noise filtering.
  const prevSet = new Set(prevTree);
  const currSet = new Set(currTree);
  const removed = prevTree.filter(l => !currSet.has(l));
  const added = currTree.filter(l => !prevSet.has(l));
  const isTextOnly = l => /^\s*\[StaticText\]/.test(l) && !isPriorityPerceiveTextLine(l);
  const isTextSummary = l => /^\s*\.\.\. \d+ earlier text node\(s\) omitted \(--last \d+\)/.test(l);
  const isCompactTextChange = l => isTextOnly(l) || isTextSummary(l);
  const removedStructural = removed.filter(l => !isCompactTextChange(l));
  const addedStructural = added.filter(l => !isCompactTextChange(l));
  const removedTextLines = removed.filter(isTextOnly);
  const addedTextLines = added.filter(isTextOnly);
  return {
    headerLines: curr.slice(0, currHeaderEnd >= 0 ? currHeaderEnd : 5),
    removedStructural,
    addedStructural,
    removedTextLines,
    addedTextLines,
  };
}

function buildPerceiveDiffRecommendation({ mode, changed, baselineAvailable = true, nextSteps = [] }) {
  const source = 'perceive-diff';
  const reason = !baselineAvailable
    ? 'No previous perceive baseline is available; capture a fresh perception before relying on diffs.'
    : changed
    ? 'The page changed; preserve the diff and action timeline before continuing.'
    : 'No page change was detected; use the report timeline or a fresh perceive before retrying the action.';
  return {
    source,
    mode,
    reason,
    commands: nextSteps,
    verifyCommand: nextSteps[0] || null,
  };
}

function buildPerceiveDiffModel(previousOutput, currentOutput, { mode = 'diff', targetPrefix = '' } = {}) {
  const diff = computePerceiveDiff(previousOutput, currentOutput);
  const target = targetPrefix || '<target>';
  const removedText = diff.removedTextLines.length;
  const addedText = diff.addedTextLines.length;
  const changed = diff.removedStructural.length > 0 || diff.addedStructural.length > 0 || removedText > 0 || addedText > 0;
  const nextSteps = mode === 'since-action'
    ? [
        `cdp report ${target} --format json`,
        `cdp record-actions ${target} --format json`,
      ]
    : [
        `cdp report ${target} --format json`,
      ];
  return {
    schema: 'chrome-cdp-ex.perceive-diff.v1',
    mode,
    ...parsePerceiveHeader(currentOutput),
    summary: {
      changed,
      removed: diff.removedStructural.length,
      added: diff.addedStructural.length,
      textRemoved: removedText,
      textAdded: addedText,
    },
    removed: diff.removedStructural.slice(0, 20),
    added: diff.addedStructural.slice(0, 20),
    removedOmitted: Math.max(0, diff.removedStructural.length - 20),
    addedOmitted: Math.max(0, diff.addedStructural.length - 20),
    textRemovedSamples: diff.removedTextLines.slice(-3),
    textAddedSamples: diff.addedTextLines.slice(-3),
    recommendation: buildPerceiveDiffRecommendation({ mode, changed, nextSteps }),
    nextSteps,
  };
}

function formatPerceiveDiffOutput(previousOutput, currentOutput) {
  const diff = computePerceiveDiff(previousOutput, currentOutput);
  const diffLines = [];
  const removedText = diff.removedTextLines.length;
  const addedText = diff.addedTextLines.length;
  if (diff.removedStructural.length === 0 && diff.addedStructural.length === 0 && removedText === 0 && addedText === 0) {
    diffLines.push('(no changes detected in AX tree)');
  } else {
    if (diff.removedStructural.length > 0) {
      diffLines.push(`--- Removed (${diff.removedStructural.length}):`);
      for (const l of diff.removedStructural.slice(0, 20)) diffLines.push(`- ${l}`);
      if (diff.removedStructural.length > 20) diffLines.push(`  ... and ${diff.removedStructural.length - 20} more`);
    }
    if (diff.addedStructural.length > 0) {
      diffLines.push(`+++ Added (${diff.addedStructural.length}):`);
      for (const l of diff.addedStructural.slice(0, 20)) diffLines.push(`+ ${l}`);
      if (diff.addedStructural.length > 20) diffLines.push(`  ... and ${diff.addedStructural.length - 20} more`);
    }
    if (removedText > 0 || addedText > 0) {
      const parts = [];
      if (removedText > 0) parts.push(`${removedText} removed`);
      if (addedText > 0) parts.push(`${addedText} added`);
      diffLines.push(`~~~ Text nodes updated (${parts.join(', ')})`);
      if (addedText > 0 && diff.removedStructural.length === 0 && diff.addedStructural.length === 0) {
        const samples = diff.addedTextLines.slice(-3);
        for (const l of samples) diffLines.push(`+ ${l}`);
        if (addedText > samples.length) diffLines.push(`  ... and ${addedText - samples.length} more text additions`);
      }
    }
  }
  return diff.headerLines.join('\n') + '\n\n' + diffLines.join('\n');
}

// Format a single @ref bounding-rect annotation. Adds `position` only for
// fixed/sticky elements so agents do not misread visible fixed UI as off-screen.
function formatRefRect(rect) {
  if (!rect) return '';
  const base = `(${rect.x},${rect.y} ${rect.w}×${rect.h}`;
  if (rect.position === 'fixed' || rect.position === 'sticky') {
    return `${base}, ${rect.position})`;
  }
  return `${base})`;
}

// Pure tree-building logic extracted from perceiveStr for testability.
// Takes raw AX nodes + page metadata, returns enriched tree lines and ref node IDs.
function buildPerceiveTree(nodes, meta, refMap, opts = {}) {
  const { maxDepth = Infinity, interactiveOnly = false, keepRefs = false, last = null } = opts;
  // opts.adaptive + opts.consoleErrors are used by the --last auto / --adaptive budget path

  const nodesById = new Map(nodes.map(n => [n.nodeId, n]));
  const childrenByParent = new Map();
  for (const n of nodes) {
    if (!n.parentId) continue;
    if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, []);
    childrenByParent.get(n.parentId).push(n);
  }

  // Layout consumption cursors (each role's entries are consumed in document order)
  const layoutCursors = {};
  for (const [role, entries] of Object.entries(meta.layoutMap || {})) {
    layoutCursors[role] = { entries, idx: 0 };
  }
  function consumeLayout(role) {
    const cursor = layoutCursors[role];
    if (!cursor || cursor.idx >= cursor.entries.length) return null;
    return cursor.entries[cursor.idx++];
  }

  // Track table rows to cap output
  const TABLE_ROW_LIMIT = 5;
  const tableRowCounts = new Map();
  const tableIdxMap = new Map();
  let nextTableIdx = 0;
  const rowCellIdx = new Map();
  const dataRowIdx = new Map();

  // Clear and rebuild ref map
  refMap.clear();
  let refCounter = 0;
  const refNodeIds = [];

  const treeLines = [];
  const visited = new Set();

  function markSubtreeVisited(nodeId) {
    visited.add(nodeId);
    for (const child of (childrenByParent.get(nodeId) || [])) {
      markSubtreeVisited(child.nodeId);
    }
  }

  function visit(node, depth, parentNode = null, tableAncestorId = null) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);

    const role = node.role?.value || '';
    const name = node.name?.value ?? '';

    // Depth limit: still assign refs but don't output deeper nodes
    if (depth > maxDepth) {
      if (INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId) {
        refCounter++;
        refMap.set(refCounter, node.backendDOMNodeId);
        refNodeIds.push({ ref: refCounter, backendDOMNodeId: node.backendDOMNodeId });
      }
      for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
        visit(child, depth + 1, node, tableAncestorId);
      }
      return;
    }

    // Detect table context: track row counts per table ancestor
    if (role === 'table' || role === 'grid' || role === 'treegrid') {
      tableAncestorId = node.nodeId;
      tableRowCounts.set(tableAncestorId, 0);
      dataRowIdx.set(tableAncestorId, -1);
      if (!tableIdxMap.has(tableAncestorId)) {
        tableIdxMap.set(tableAncestorId, nextTableIdx++);
      }
    }
    if (tableAncestorId && role === 'row') {
      const count = tableRowCounts.get(tableAncestorId) || 0;
      tableRowCounts.set(tableAncestorId, count + 1);
      rowCellIdx.set(tableAncestorId, 0);
      if (count >= TABLE_ROW_LIMIT) {
        if (count === TABLE_ROW_LIMIT) {
          treeLines.push(formatAxNode({ role: { value: 'note' }, name: { value: '... more rows truncated' } }, depth));
        }
        markSubtreeVisited(node.nodeId);
        return;
      }
    }

    // Filter decorative icon images (short lowercase names like "thunderbolt", "check-circle")
    if (role === 'image') {
      if (name.length < 25 && name === name.toLowerCase() && !name.includes(' ')) {
        markSubtreeVisited(node.nodeId);
        return;
      }
    }

    // Track cell index unconditionally (even for filtered nodes) to stay aligned with browser-side
    const isCellRole = tableAncestorId && (role === 'cell' || role === 'gridcell' || role === 'columnheader' || role === 'rowheader');
    let cellColIdx = -1;
    if (isCellRole) {
      cellColIdx = rowCellIdx.get(tableAncestorId) || 0;
      rowCellIdx.set(tableAncestorId, cellColIdx + 1);
      if ((role === 'cell' || role === 'gridcell') && cellColIdx === 0) {
        dataRowIdx.set(tableAncestorId, (dataRowIdx.get(tableAncestorId) ?? -1) + 1);
      }
    }

    const isInteractive = INTERACTIVE_ROLES.has(role);

    // --interactive mode: only show interactive elements and their immediate structural parents
    if (interactiveOnly && !isInteractive && !ENRICHED_ROLES.has(role)) {
      for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
        visit(child, depth, node, tableAncestorId);
      }
      return;
    }

    if (shouldShowAxNode(node, true, parentNode)) {
      let line = formatAxNode(node, depth);

      // Assign @ref to interactive elements
      if (isInteractive && node.backendDOMNodeId) {
        refCounter++;
        refMap.set(refCounter, node.backendDOMNodeId);
        refNodeIds.push({ ref: refCounter, backendDOMNodeId: node.backendDOMNodeId });
        line += `  @${refCounter}`;
      }

      // Enrich landmark/structural nodes with layout annotations
      if (ENRICHED_ROLES.has(role)) {
        const layout = consumeLayout(role);
        if (layout) {
          const parts = [];
          if (layout.w) parts.push(`${layout.w}×${layout.h}px`);
          else if (layout.h >= 40) parts.push(`↕${layout.h}px`);
          if (layout.bg) parts.push(`bg:${layout.bg}`);
          if (layout.font) parts.push(layout.font);
          if (layout.color) parts.push(`color:${layout.color}`);
          if (layout.display) {
            let d = layout.display;
            if (layout.gap) d += ` gap:${layout.gap}`;
            parts.push(d);
          }
          if (layout.opacity) parts.push(`opacity:${layout.opacity}`);
          if (layout.vis === 'above') parts.push('↑above fold');
          else if (layout.vis === 'below') parts.push('↓below fold');
          if (parts.length > 0) line += '  ' + parts.join('  ');
        }
      }

      // Enrich table cells with style hints (positional key: tableIdx:rowIdx:colIdx)
      if (isCellRole && meta.styleHints) {
        const ti = tableIdxMap.get(tableAncestorId);
        const ri = dataRowIdx.get(tableAncestorId) ?? -1;
        if (ti != null && ri >= 0) {
          const hint = meta.styleHints[ti + ':' + ri + ':' + cellColIdx];
          if (hint) line += '  ' + hint;
        }
      }
      treeLines.push(line);
    }
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1, node, tableAncestorId);
    }
  }

  const roots = nodes.filter(n => !n.parentId || !nodesById.has(n.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  // --last N: keep only the last N StaticText / paragraph rows. Ref-bearing
  // lines (anything containing `@<digit>` or `@c<digit>`) and structural lines
  // (landmarks, headings, dialogs, etc.) are always kept.
  // --keep-refs: when truncating, ensure every line carrying an @ref survives.
  // --adaptive / --last auto: choose N from density + error/priority signals.
  let outLines = treeLines;
  let effectiveLast = last;
  if (last === 'auto' || (opts.adaptive && (last == null || last === 'auto'))) {
    const interactiveCount = outLines.filter(ln => /@(c?\d+)/.test(ln)).length;
    const hasPriorityText = outLines.some(ln => isPriorityPerceiveTextLine(ln));
    effectiveLast = chooseAdaptivePerceiveLast({
      lineCount: outLines.length,
      consoleErrors: Number(opts.consoleErrors || 0),
      interactiveCount,
      hasPriorityText,
    });
  }
  if (effectiveLast && Number.isFinite(effectiveLast) && effectiveLast > 0) {
    const refLineRe = /@(c?\d+)/;
    const textRoleRe = /\[(StaticText|paragraph|listitem|note|description|comment|term|definition)\]/;
    // Walk backwards collecting the last N text lines while keeping all ref/structural lines
    const reversed = [];
    let textKept = 0;
    let priorityKept = 0;
    const priorityBudget = Math.max(effectiveLast, 12);
    let textOmitted = 0;
    for (let i = outLines.length - 1; i >= 0; i--) {
      const ln = outLines[i];
      const isRef = refLineRe.test(ln);
      const isText = textRoleRe.test(ln) && !isRef;
      if (isText) {
        if (isPriorityPerceiveTextLine(ln) && priorityKept < priorityBudget) { reversed.push(ln); priorityKept++; }
        else if (textKept < effectiveLast) { reversed.push(ln); textKept++; }
        else { textOmitted++; }
      } else {
        reversed.push(ln);
      }
    }
    outLines = reversed.reverse();
    if (textOmitted > 0) {
      const label = (last === 'auto' || opts.adaptive) ? `--adaptive last ${effectiveLast}` : `--last ${effectiveLast}`;
      outLines.push(`  ... ${textOmitted} earlier text node(s) omitted (${label})`);
    }
  } else if (keepRefs) {
    // No size budget enforced here; the caller chooses when to truncate, but
    // when --keep-refs is set we mark lines so downstream truncation can
    // protect them. We currently return the lines as-is (the truncation that
    // hid refs was happening elsewhere; --keep-refs is now a soft flag agents
    // can use to assert "do not drop my @ref lines"). The flag is honoured
    // upstream by perceiveStr which avoids cutting ref lines.
  }

  return { treeLines: outLines, refNodeIds };
}

// Browser-side script for perceiveStr — extracted for readability and testability.
// Collects page metadata, layout map, style hints, and cursor-interactive elements.
function perceivePageScript(cursorInteractive) {
  return `(function() {
${visibleControlsCollectorSource()}
      const vw = window.innerWidth, vh = window.innerHeight;
      const scrollY = Math.round(window.scrollY);
      const scrollMax = Math.round(document.documentElement.scrollHeight - window.innerHeight);

      // Interactive element counts
      const counts = {};
      for (const el of document.querySelectorAll('a, button, input, select, textarea, [role="button"], [tabindex]')) {
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? 'input[' + (el.type || 'text') + ']' : tag;
        counts[type] = (counts[type] || 0) + 1;
      }

      // Build layout map keyed by ARIA role (matching AX tree roles)
      const TAG_ROLE = {
        header:'banner', nav:'navigation', main:'main', footer:'contentinfo',
        aside:'complementary', form:'form', table:'table', dialog:'dialog',
        article:'article', section:'region', img:'img', video:'video',
        h1:'heading', h2:'heading', h3:'heading', h4:'heading', h5:'heading', h6:'heading'
      };
      const selectors = 'header,nav,main,footer,aside,section,article,form,h1,h2,h3,h4,h5,h6,img,video,table,dialog,[role="banner"],[role="navigation"],[role="main"],[role="contentinfo"],[role="dialog"],[role="alert"],[role="region"],[role="complementary"]';
      const layoutMap = {};
      let count = 0;
      for (const el of document.querySelectorAll(selectors)) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || TAG_ROLE[tag] || tag;
        const info = { h: Math.round(rect.height) };

        // Only include width if element is significantly narrower than viewport
        const w = Math.round(rect.width);
        if (w < vw * 0.9) info.w = w;

        // Key visual properties (only non-defaults)
        const bg = cs.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') info.bg = bg;
        if (tag.match(/^h[1-6]$/)) {
          info.font = cs.fontSize + ' ' + cs.fontWeight;
          if (cs.color && cs.color !== 'rgb(0, 0, 0)') info.color = cs.color;
        }
        if (cs.display === 'flex' || cs.display === 'grid') {
          info.display = cs.display;
          if (cs.gap && cs.gap !== 'normal' && cs.gap !== '0px') info.gap = cs.gap;
        }
        if (cs.opacity !== '1') info.opacity = cs.opacity;

        // Viewport visibility
        const top = rect.top, bot = rect.bottom;
        if (bot < 0) info.vis = 'above';
        else if (top > vh) info.vis = 'below';
        // else: in viewport (default, no annotation needed)

        if (!layoutMap[role]) layoutMap[role] = [];
        layoutMap[role].push(info);
        if (++count >= 150) break;
      }

      // === Style hints: detect visual anomalies on table cells ===
      const styleHints = {};
      let styleHintCount = 0;
      const CELL_SEL = 'td, th, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]';
      const BASELINE_ROW_CAP = 20; // enough rows for reliable baseline, avoids scanning huge tables
      function majority(counts) {
        let best = null, bestN = 0;
        for (const [v, n] of Object.entries(counts)) { if (n > bestN) { best = v; bestN = n; } }
        return best;
      }
      const allTables = document.querySelectorAll('table, [role="grid"], [role="treegrid"]');
      // Filter out presentation/hidden tables to match AX tree traversal order
      const visTables = [];
      for (const t of allTables) {
        const r = t.getAttribute('role');
        if (r === 'presentation' || r === 'none') continue;
        if (t.getAttribute('aria-hidden') === 'true') continue;
        const cs = window.getComputedStyle(t);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        visTables.push(t);
      }
      for (let ti = 0; ti < visTables.length && styleHintCount < 100; ti++) {
        const tbl = visTables[ti];
        const rows = tbl.querySelectorAll('tr, [role="row"]');
        const dataRows = [];
        for (const row of rows) {
          const firstCell = row.querySelector('td, [role="cell"], [role="gridcell"]');
          if (firstCell) dataRows.push(row);
        }
        if (dataRows.length === 0) continue;
        const smallTable = dataRows.length < 4;
        const scanRows = dataRows.slice(0, BASELINE_ROW_CAP);

        // Single pass: collect styles, build baselines, cache per-cell data
        const colBgs = {}, colWeights = {}, colColors = {};
        const cellCache = []; // [{cells: [{bg, fw, clr, ci}]}] per row
        for (const row of scanRows) {
          const cells = row.querySelectorAll(CELL_SEL);
          const rowData = [];
          let ci = 0;
          for (const cell of cells) {
            if (cell.colSpan > 1) { ci += cell.colSpan; continue; }
            const cs = window.getComputedStyle(cell);
            const bg = cs.backgroundColor;
            const fw = parseInt(cs.fontWeight) || 400;
            const clr = cs.color;
            if (!colBgs[ci]) { colBgs[ci] = {}; colWeights[ci] = {}; colColors[ci] = {}; }
            colBgs[ci][bg] = (colBgs[ci][bg] || 0) + 1;
            colWeights[ci][fw] = (colWeights[ci][fw] || 0) + 1;
            colColors[ci][clr] = (colColors[ci][clr] || 0) + 1;
            rowData.push({ bg, fw, clr, ci });
            ci++;
          }
          cellCache.push(rowData);
        }

        // Compute baselines from collected data
        const baseBg = {}, baseWeight = {}, baseColor = {};
        for (const ci of Object.keys(colBgs)) {
          baseBg[ci] = majority(colBgs[ci]);
          baseWeight[ci] = parseInt(majority(colWeights[ci])) || 400;
          baseColor[ci] = majority(colColors[ci]);
        }

        // Emit hints from cached styles (no second getComputedStyle pass)
        for (let ri = 0; ri < cellCache.length; ri++) {
          for (const { bg, fw, clr, ci } of cellCache[ri]) {
            const hints = [];
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              if (smallTable || bg !== baseBg[ci]) hints.push('bg:' + bg);
            }
            if (fw > 400 && (smallTable || fw !== baseWeight[ci])) hints.push('bold');
            if (clr && clr !== 'rgb(0, 0, 0)') {
              if (smallTable || clr !== baseColor[ci]) hints.push('color:' + clr);
            }
            if (hints.length > 0) {
              styleHints[ti + ':' + ri + ':' + ci] = hints.join(' ');
              if (++styleHintCount >= 100) break;
            }
          }
          if (styleHintCount >= 100) break;
        }
      }

      // Focused element
      const focused = document.activeElement;
      const focusDesc = focused && focused !== document.body
        ? '<' + focused.tagName.toLowerCase() + (focused.id ? '#' + focused.id : '') + '>'
        : 'none';

      // Cursor-interactive scan: find non-ARIA clickable elements (cursor:pointer, onclick, tabindex)
      const cursorInteractives = [];
      let visibleControls = [];
      let visibleControlsTruncated = false;
      if (${cursorInteractive}) {
        const visibleControlsModel = chromeCdpVisibleControls({ limit: 30 });
        visibleControls = visibleControlsModel.controls || [];
        visibleControlsTruncated = Boolean(visibleControlsModel.truncated);

        const ARIA_INTERACTIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA']);
        const seen = new Set();
        const candidates = document.querySelectorAll('div, span, li, td, tr, label, img, svg, i, p, section, article, [onclick], [tabindex]:not(a):not(button):not(input):not(select):not(textarea)');
        for (const el of candidates) {
          if (ARIA_INTERACTIVE.has(el.tagName)) continue;
          if (el.getAttribute('role')) continue;
          if (el.closest('a, button, input, select, textarea, [role]')) continue;
          const cs = window.getComputedStyle(el);
          const clickable = cs.cursor === 'pointer' || el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0);
          if (!clickable) continue;
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 5 || rect.height < 5) continue;
          // Build a CSS selector path for this element
          let sel = el.tagName.toLowerCase();
          if (el.id) sel += '#' + CSS.escape(el.id);
          else if (el.className && typeof el.className === 'string') {
            const cls = el.className.trim().split(/\\s+/).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
            sel += cls;
          }
          const key = sel + '|' + Math.round(rect.x) + ',' + Math.round(rect.y);
          if (seen.has(key)) continue;
          seen.add(key);
          const text = el.textContent.trim().substring(0, 60);
          cursorInteractives.push({ sel, text, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
          if (cursorInteractives.length >= 50) break;
        }
      }

      return JSON.stringify({
        title: document.title, url: window.location.href,
        vw, vh, scrollY, scrollMax,
        counts, focused: focusDesc, layoutMap, styleHints, cursorInteractives,
        visibleControls, visibleControlsTruncated
      });
    })()`;
}

async function perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const {
    diff: diffMode = false, selector: scopeSelector = null, exclude: excludeSelector = null,
    interactive: interactiveOnly = false, maxDepth = Infinity, cursorInteractive = false,
    keepRefs = false, last = null, adaptive = false, sinceAction = false, diffBaseline = null,
    frameRef = null,
  } = opts;
  const frameContext = frameRef ? await resolveFrameRef(cdp, sid, frameRef) : null;
  const frame = frameContext?.frame || null;
  const frameExecutionContextId = frame ? await createFrameExecutionContext(cdp, sid, frame.id) : null;
  if (frame && (scopeSelector || excludeSelector)) {
    throw new Error('perceive --frame does not yet support --selector/--exclude; run frame-scoped perceive first, then use the listed @fN:M refs.');
  }
  // Get AX tree nodes and page metadata + layout map in parallel
  // Hoist DOM.getDocument so scope and exclude can share it
  const needsDocument = !frame && (scopeSelector || excludeSelector);
  const docRootPromise = needsDocument ? cdp.send('DOM.getDocument', {}, sid) : null;
  let scopeBackendNodeIds = null;
  const axPromise = frame
    ? cdp.send('Accessibility.getFullAXTree', { frameId: frame.id }, sid)
    : scopeSelector
    ? (async () => {
        const { root } = await docRootPromise;
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: scopeSelector }, sid);
        if (!nodeId) throw new Error(`Scope selector not found: ${scopeSelector}`);
        const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: -1, pierce: true }, sid);
        scopeBackendNodeIds = collectDomBackendNodeIds(node);
        return cdp.send('Accessibility.getFullAXTree', {}, sid);
      })()
    : cdp.send('Accessibility.getFullAXTree', {}, sid);
  const [axResult, metaJson] = await Promise.all([
    axPromise,
    evalStr(cdp, sid, perceivePageScript(cursorInteractive), false, frameExecutionContextId != null ? { contextId: frameExecutionContextId } : {})
  ]);

  const meta = JSON.parse(metaJson);

  // Console health
  const allConsole = consoleBuf.all();
  let errors = 0, warnings = 0;
  for (const e of allConsole) {
    if (e.level === 'error') errors++;
    else if (e.level === 'warning' || e.level === 'warn') warnings++;
  }
  const exceptions = exceptionBuf.all().length;

  // Exclude filtering: remove AX subtrees rooted at excluded DOM nodes
  let axNodes = axResult.nodes;
  if (scopeBackendNodeIds) {
    axNodes = filterAxNodesToBackendSubtree(axNodes, scopeBackendNodeIds);
  }
  if (excludeSelector) {
    const { root } = await docRootPromise;
    const excludedBackendNodeIds = new Set();
    const exNodes = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: excludeSelector }, sid);
    if (exNodes.nodeIds) {
      const results = await Promise.allSettled(
        exNodes.nodeIds.map(nid => cdp.send('DOM.describeNode', { nodeId: nid }, sid))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.node.backendNodeId)
          excludedBackendNodeIds.add(r.value.node.backendNodeId);
      }
    }
    if (excludedBackendNodeIds.size > 0) {
      const excludedAxIds = new Set();
      for (const n of axNodes) {
        if (n.backendDOMNodeId && excludedBackendNodeIds.has(n.backendDOMNodeId)) excludedAxIds.add(n.nodeId);
      }
      if (excludedAxIds.size > 0) {
        const childMap = new Map();
        for (const n of axNodes) {
          if (n.parentId) {
            if (!childMap.has(n.parentId)) childMap.set(n.parentId, []);
            childMap.get(n.parentId).push(n.nodeId);
          }
        }
        const queue = [...excludedAxIds];
        while (queue.length) {
          const id = queue.pop();
          for (const child of (childMap.get(id) || [])) {
            excludedAxIds.add(child);
            queue.push(child);
          }
        }
        axNodes = axNodes.filter(n => !excludedAxIds.has(n.nodeId));
      }
    }
  }

  const activeRefMap = frame ? new Map() : refMap;
  const builtTree = buildPerceiveTree(axNodes, meta, activeRefMap, {
    maxDepth,
    interactiveOnly,
    keepRefs,
    last,
    adaptive,
    consoleErrors: errors + exceptions,
  });
  let treeLines = builtTree.treeLines;
  const { refNodeIds } = builtTree;
  if (frame) storeFrameScopedRefs(refState, frame, frameContext.frames, activeRefMap);

  // === Batch-resolve @ref bounding rects (parallel, non-scrolling) ===
  // Now also returns `position` (computed style) so fixed/sticky elements get
  // a clear annotation — agents previously saw negative document-relative Ys
  // and assumed elements were off-screen.
  const refRects = new Map(); // ref number → {x, y, w, h, position?}
  const frameOffset = frame
    ? await frameViewportOffset(cdp, sid, {
        ...frame,
        frameRef: frame.ref,
        frameId: frame.id,
        frames: frameContext.frames,
      })
    : { x: 0, y: 0 };
  if (refNodeIds.length > 0) {
    const results = await Promise.allSettled(refNodeIds.map(async ({ ref, backendDOMNodeId }) => {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: backendDOMNodeId }, sid);
      const res = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function() {
          const r = this.getBoundingClientRect();
          const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(this) : null;
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            position: cs ? cs.position : '',
          };
        }`,
        returnByValue: true,
      }, sid);
      const rect = res.result.value || {};
      if (frame) {
        rect.x = (Number(rect.x) || 0) + frameOffset.x;
        rect.y = (Number(rect.y) || 0) + frameOffset.y;
      }
      return { ref, rect };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') refRects.set(r.value.ref, r.value.rect);
    }
  }

  // Inject @ref coordinates into treeLines (top-level viewport CSS pixels; same space as clickxy)
  for (let i = 0; i < treeLines.length; i++) {
    const m = treeLines[i].match(/@(\d+)$/);
    if (m) {
      const rect = refRects.get(parseInt(m[1]));
      if (rect) treeLines[i] += `  ${formatRefRect(rect)}`;
    }
  }
  if (frame) treeLines = qualifyFrameRefsInLines(treeLines, frame.ref);

  // === Cursor-interactive @c refs ===
  let cRefCounter = 0;
  if (cursorInteractive && meta.cursorInteractives?.length > 0) {
    treeLines.push('');
    treeLines.push('[Cursor-interactive elements] (non-ARIA clickable)');
    for (const ci of meta.cursorInteractives) {
      cRefCounter++;
      refMap.set(`c${cRefCounter}`, ci);
      treeLines.push(`  [clickable] ${ci.text || ci.sel}  @c${cRefCounter}  (${ci.x},${ci.y} ${ci.w}×${ci.h})`);
    }
  }
  if (cursorInteractive && meta.visibleControls?.length > 0) {
    treeLines.push('');
    treeLines.push(`[Visible controls]${meta.visibleControlsTruncated ? ' (truncated)' : ''}`);
    for (const control of meta.visibleControls) {
      treeLines.push(`  ${formatVisibleControlLine(control)}`);
    }
  }

  // === Assemble output ===
  const lines = [];
  lines.push(`Page: ${meta.title} — ${meta.url}`);
  if (frame) {
    const label = frame.name || '(anonymous)';
    const url = frame.url || frame.unreachableUrl || '(no url)';
    lines.push(`Frame: ${frame.ref} ${label} ${frame.id} ${url}`);
  }

  const scrollPct = meta.scrollMax > 0 ? Math.round(meta.scrollY / meta.scrollMax * 100) : 0;
  lines.push(`Viewport: ${meta.vw}×${meta.vh} | Scroll: ${meta.scrollY}/${meta.scrollMax > 0 ? meta.scrollMax : 0} (${scrollPct}%) | Focused: ${meta.focused}`);

  const countParts = Object.entries(meta.counts).map(([k, v]) => `${v} ${k}`);
  lines.push(`Interactive: ${countParts.length > 0 ? countParts.join(', ') : 'none'}`);

  const healthParts = [];
  if (errors > 0) healthParts.push(`${errors} error${errors > 1 ? 's' : ''}`);
  if (warnings > 0) healthParts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
  if (exceptions > 0) healthParts.push(`${exceptions} exception${exceptions > 1 ? 's' : ''}`);
  lines.push(`Console: ${healthParts.length > 0 ? healthParts.join(', ') : 'clean'}`);
  // Coordinate hint — top-level viewport CSS pixels match clickxy/Input events.
  // Fixed/sticky elements include a "fixed"/"sticky" tag so agents do not
  // misread negative scroll-relative Ys as off-screen.
  lines.push(`Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)`);

  lines.push('');
  lines.push(...treeLines);

  const output = lines.join('\n');

  const markPerceived = () => {
    lastPerceiveStore.output = output;
    if (frame) rememberFramePerceiveOutput(refState, frame.ref, output);
    // Mark refs as freshly assigned (clears 'navigation'/'daemon-start' state).
    if (refState && typeof refState === 'object') {
      refState.generation = (refState.generation || 0) + 1;
      refState.lastPerceiveAt = Date.now();
      refState.invalidationReason = null;
    }
  };

  if (sinceAction) {
    markPerceived();
    if (!diffBaseline) {
      return output + '\n\n(no action baseline available; run `perceive` before a mutating command, or use `perceive --diff` after a normal perceive.)';
    }
    return formatPerceiveDiffOutput(diffBaseline, output);
  }

  // Diff mode: compare with previous perceive output.
  if (diffMode && lastPerceiveStore.output) {
    const previousOutput = lastPerceiveStore.output;
    markPerceived();
    return formatPerceiveDiffOutput(previousOutput, output);
  }

  markPerceived();
  // Hint when perceive returns many interactive elements without exclude
  if (interactiveOnly && !excludeSelector && refNodeIds.length > 50) {
    return output + `\n\n(Hint: ${refNodeIds.length} interactive elements found — most may be sidebar/nav noise. Use \`perceive -x "nav, aside"\` to exclude, or \`perceive -s "main"\` to scope.)`;
  }
  return output;
}

function perceptionModelFromText(output, refState = {}, targetPrefix = '<target>', opts = {}) {
  const lines = String(output || '').split('\n');
  const header = parsePerceiveHeader(output);

  const nodes = [];
  for (const line of lines) {
    const refMatch = line.match(/\[(\w+)\]\s+(.+?)\s+(@f\d+:\d+|@\d+)(?:\s+\((-?\d+),(-?\d+) (\d+)×(\d+)(?:, [^)]+)?\))?$/);
    if (!refMatch) continue;
    const [, role, rawName, ref, x, y, width, height] = refMatch;
    const node = {
      ref,
      role,
      name: rawName.trim(),
    };
    if (x !== undefined) {
      node.rect = {
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
      };
    }
    nodes.push(node);
  }

  return createPerceptionModel({
    targetPrefix,
    page: header.page,
    viewport: header.viewport,
    consoleHealth: header.console,
    refs: { generation: refState.generation || 0 },
    nodes,
    limits: {
      truncated: output.includes('truncated'),
      ...(opts.last ? { lastTextRows: opts.last, outputTokenBudget: opts.last * 80 } : {}),
    },
  });
}

async function perceiveModel(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const output = await perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts, refState);
  return perceptionModelFromText(output, refState || {}, opts.targetPrefix || '<target>', opts);
}

async function perceiveDiffModel(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const mode = opts.sinceAction ? 'since-action' : 'diff';
  const baseline = opts.sinceAction ? opts.diffBaseline : lastPerceiveStore.output;
  const currentOutput = await perceiveStr(
    cdp,
    sid,
    consoleBuf,
    exceptionBuf,
    refMap,
    lastPerceiveStore,
    { ...opts, sinceAction: false, diff: false, diffBaseline: null },
    refState
  );
  if (!baseline) {
    const header = parsePerceiveHeader(currentOutput);
    const target = opts.targetPrefix || '<target>';
    const nextSteps = [
      `cdp perceive ${target} -C -d 8`,
      `cdp report ${target} --format json`,
    ];
    return {
      schema: 'chrome-cdp-ex.perceive-diff.v1',
      mode,
      baselineAvailable: false,
      ...header,
      summary: {
        changed: null,
        removed: 0,
        added: 0,
        textRemoved: 0,
        textAdded: 0,
      },
      removed: [],
      added: [],
      removedOmitted: 0,
      addedOmitted: 0,
      textRemovedSamples: [],
      textAddedSamples: [],
      recommendation: buildPerceiveDiffRecommendation({
        mode,
        changed: null,
        baselineAvailable: false,
        nextSteps,
      }),
      nextSteps,
    };
  }
  return buildPerceiveDiffModel(baseline, currentOutput, {
    mode,
    targetPrefix: opts.targetPrefix || '',
  });
}

// Element screenshot: targeted capture of a specific element by CSS selector or @ref
async function elshotStr(cdp, sid, selector, targetId, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector, refState);
    const pad = 8;
    const clipX = Math.max(0, r.x - pad);
    const clipY = Math.max(0, r.y - pad);
    const clipW = r.w + pad * 2;
    const clipH = r.h + pad * 2;
    await sleep(100);
    const clip = { x: clipX, y: clipY, width: clipW, height: clipH, scale: 1 };
    const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png', clip });
    const prefix = (targetId || 'unknown').slice(0, 8);
    const out = resolve(RUNTIME_DIR, `elshot-${prefix}-ref${selector.slice(1)}.png`);
    writeFileSync(out, Buffer.from(data, 'base64'));
    const fb = fallback ? ' (fallback)' : '';
    return `${out}\nElement screenshot of <${r.tag}> "${r.text}" (${selector}) — ${Math.round(r.w)}×${Math.round(r.h)} CSS px${fb}`;
  }
  // Scroll element into view and get its bounding rect
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        ok: true,
        x: rect.x, y: rect.y, w: rect.width, h: rect.height,
        tag: el.tagName, id: el.id,
        text: el.textContent.trim().substring(0, 60)
      };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);

  // Small padding around the element (clamped to viewport)
  const pad = 8;
  const clipX = Math.max(0, r.x - pad);
  const clipY = Math.max(0, r.y - pad);
  const clipW = r.w + pad * 2;
  const clipH = r.h + pad * 2;

  await sleep(100); // let scroll settle

  const clip = { x: clipX, y: clipY, width: clipW, height: clipH, scale: 1 };
  const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png', clip });

  const prefix = (targetId || 'unknown').slice(0, 8);
  const selSafe = selector.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
  const out = resolve(RUNTIME_DIR, `elshot-${prefix}-${selSafe}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  const desc = `<${r.tag}>${r.id ? '#' + r.id : ''} "${r.text}"`;
  const fb = fallback ? ' (fallback)' : '';
  return `${out}\nElement screenshot of ${desc} — ${Math.round(r.w)}×${Math.round(r.h)} CSS px (clip: ${Math.round(clipW)}×${Math.round(clipH)} with padding)${fb}`;
}

// Shared: dispatch a realistic mouse click at CSS pixel coordinates
async function dispatchClick(cdp, sid, x, y) {
  const base = { x, y, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
}

// Shared: get device pixel ratio
async function getDpr(cdp, sid) {
  try {
    const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
    const parsed = parseFloat(raw);
    if (parsed > 0) return parsed;
  } catch {}
  return 1;
}

async function resolveSelectorNode(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  try { await cdp.send('DOM.enable', {}, sid); } catch {}
  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  let result;
  try {
    result = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sid);
  } catch (e) {
    throw new Error(`Invalid selector: ${selector}. ${e.message}`);
  }
  if (!result.nodeId) throw new Error('Element not found: ' + selector);
  const { object } = await cdp.send('DOM.resolveNode', { nodeId: result.nodeId }, sid);
  return object.objectId;
}

// JS-fallback click: uses HTMLElement.click() / dispatchEvent in the page
// instead of CDP Input.dispatchMouseEvent. Useful when the page intercepts
// real-pointer events with overlays, has misaligned hit testing under custom
// transforms, or when an MUD/game UI binds handlers only to synthetic clicks.
// This path is intentionally separate from clickStr — agents opt into it via
// `jsclick` or `click --js` so the default behaviour stays a realistic mouse
// dispatch.
async function jsClickStr(cdp, sid, selector, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  const objectId = isRef(selector)
    ? await resolveRefNode(cdp, sid, refMap, selector, refState)
    : await resolveSelectorNode(cdp, sid, selector);
  try {
    const res = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof this.click === 'function') this.click();
        else this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { tag: this.tagName, text: (this.textContent || '').trim().substring(0, 80) };
      }`,
      returnByValue: true,
    }, sid);
    const r = res.result.value || {};
    return `JS-clicked <${r.tag || '?'}> "${r.text || ''}"${isRef(selector) ? ` (${selector})` : ''}`;
  } catch (e) {
    if (isTimeoutError(e, ['Runtime.callFunctionOn'])) {
      return `JS-click dispatched for ${selector}; success but click acknowledgement timed out after dispatch (${e.message}). Run \`perceive --diff\` or \`status\` to refresh observation.`;
    }
    throw e;
  }
}

// Click element by CSS selector or @ref
async function clickStr(cdp, sid, selector, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (isCursorRef(selector)) {
    const r = resolveCursorRef(refMap, selector, refState);
    await dispatchClick(cdp, sid, r.x + r.w / 2, r.y + r.h / 2);
    return `Clicked <${r.sel}> "${r.text}" (${selector})`;
  }
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector, refState);
    await dispatchClick(cdp, sid, r.x + r.w / 2, r.y + r.h / 2);
    return `Clicked <${r.tag}> "${r.text}" (${selector})`;
  }
  const expr = `
    (async function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      const rect = await (${scrollSettledRectFunctionDeclaration()}).call(el);
      return { ok: true, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, tag: rect.tag, text: rect.text };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  await dispatchClick(cdp, sid, r.x, r.y);
  return `Clicked <${r.tag}> "${r.text}"`;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  await dispatchClick(cdp, sid, cx, cy);
  return `Clicked at CSS (${cx}, ${cy})`;
}

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

const KEY_MAP = {
  enter:      { key: 'Enter',      code: 'Enter',      keyCode: 13 },
  tab:        { key: 'Tab',        code: 'Tab',        keyCode: 9 },
  escape:     { key: 'Escape',     code: 'Escape',     keyCode: 27 },
  backspace:  { key: 'Backspace',  code: 'Backspace',  keyCode: 8 },
  delete:     { key: 'Delete',     code: 'Delete',     keyCode: 46 },
  space:      { key: ' ',          code: 'Space',      keyCode: 32 },
  arrowup:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
  arrowdown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
  arrowleft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};

// Punctuation → CDP code/keyCode map for unshifted US keys
const PUNCT_KEY_MAP = {
  '`': { code: 'Backquote',    keyCode: 192 },
  '-': { code: 'Minus',        keyCode: 189 },
  '=': { code: 'Equal',        keyCode: 187 },
  '[': { code: 'BracketLeft',  keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\':{ code: 'Backslash',    keyCode: 220 },
  ';': { code: 'Semicolon',    keyCode: 186 },
  "'": { code: 'Quote',        keyCode: 222 },
  ',': { code: 'Comma',        keyCode: 188 },
  '.': { code: 'Period',       keyCode: 190 },
  '/': { code: 'Slash',        keyCode: 191 },
};

// Shifted printable punctuation on a US keyboard. `key` stays the visible
// character, while code/keyCode identify the physical base key.
const SHIFTED_PUNCT_KEY_MAP = {
  '~': { code: 'Backquote',    keyCode: 192 },
  '_': { code: 'Minus',        keyCode: 189 },
  '+': { code: 'Equal',        keyCode: 187 },
  '{': { code: 'BracketLeft',  keyCode: 219 },
  '}': { code: 'BracketRight', keyCode: 221 },
  '|': { code: 'Backslash',    keyCode: 220 },
  ':': { code: 'Semicolon',    keyCode: 186 },
  '"': { code: 'Quote',        keyCode: 222 },
  '<': { code: 'Comma',        keyCode: 188 },
  '>': { code: 'Period',       keyCode: 190 },
  '?': { code: 'Slash',        keyCode: 191 },
  '!': { code: 'Digit1',       keyCode: 49 },
  '@': { code: 'Digit2',       keyCode: 50 },
  '#': { code: 'Digit3',       keyCode: 51 },
  '$': { code: 'Digit4',       keyCode: 52 },
  '%': { code: 'Digit5',       keyCode: 53 },
  '^': { code: 'Digit6',       keyCode: 54 },
  '&': { code: 'Digit7',       keyCode: 55 },
  '*': { code: 'Digit8',       keyCode: 56 },
  '(': { code: 'Digit9',       keyCode: 57 },
  ')': { code: 'Digit0',       keyCode: 48 },
};

// Resolve a press argument (named key or single-character) to a CDP descriptor.
// Returns { key, code, keyCode, shift? } or null when unsupported.
function keyForPress(input) {
  if (!input || typeof input !== 'string') return null;
  const named = KEY_MAP[input.toLowerCase()];
  if (named) return { ...named };
  if (input.length !== 1) return null;
  // a-z
  if (/^[a-z]$/.test(input)) {
    return { key: input, code: 'Key' + input.toUpperCase(), keyCode: input.toUpperCase().charCodeAt(0) };
  }
  // A-Z (shift-modified)
  if (/^[A-Z]$/.test(input)) {
    return { key: input, code: 'Key' + input, keyCode: input.charCodeAt(0), shift: true };
  }
  // 0-9
  if (/^[0-9]$/.test(input)) {
    return { key: input, code: 'Digit' + input, keyCode: input.charCodeAt(0) };
  }
  if (Object.prototype.hasOwnProperty.call(PUNCT_KEY_MAP, input)) {
    const p = PUNCT_KEY_MAP[input];
    return { key: input, code: p.code, keyCode: p.keyCode };
  }
  if (Object.prototype.hasOwnProperty.call(SHIFTED_PUNCT_KEY_MAP, input)) {
    const p = SHIFTED_PUNCT_KEY_MAP[input];
    return { key: input, code: p.code, keyCode: p.keyCode, shift: true };
  }
  return null;
}

async function pressStr(cdp, sid, keyName) {
  if (!keyName) throw new Error('Key name required (Enter, Tab, Escape, Backspace, Space, Arrow*, or single character a-z/A-Z/0-9/punctuation)');
  const mapped = keyForPress(keyName);
  if (!mapped) throw new Error(
    `Unknown key: ${keyName}. Supported: ${Object.keys(KEY_MAP).join(', ')}, single characters (a-z, A-Z, 0-9, common punctuation). Use \`type\` for multi-character text.`
  );
  const modifiers = mapped.shift ? 8 : 0;
  const base = {
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.keyCode,
    nativeVirtualKeyCode: mapped.keyCode,
    modifiers,
  };
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' }, sid);
  // For printable single characters, send a `char` event so the page receives input
  // (mirrors what real keyboards do for letter / digit / punctuation keys).
  if (mapped.key.length === 1 && mapped.code !== 'Space' && mapped.key !== ' ') {
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'char', text: mapped.key, unmodifiedText: mapped.key }, sid);
  }
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sid);
  return `Pressed ${mapped.key}`;
}

async function scrollStr(cdp, sid, direction, amount) {
  const px = parseInt(amount) || 500;
  const dirMap = { down: [0, px], up: [0, -px], left: [-px, 0], right: [px, 0] };
  let dx, dy;
  if (dirMap[direction?.toLowerCase()]) {
    [dx, dy] = dirMap[direction.toLowerCase()];
  } else if (direction?.includes(',')) {
    [dx, dy] = direction.split(',').map(Number);
    if (isNaN(dx) || isNaN(dy)) throw new Error('Invalid coordinates. Use "down", "up", or "x,y"');
  } else {
    throw new Error('Direction required: down, up, left, right, or x,y');
  }
  const result = await evalStr(cdp, sid, `(window.scrollBy(${dx}, ${dy}), JSON.stringify({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) }))`);
  const pos = JSON.parse(result);
  return `Scrolled by (${dx}, ${dy}). Position: (${pos.x}, ${pos.y})`;
}

async function hoverStr(cdp, sid, selector, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector, refState);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await cdp.send('Input.dispatchMouseEvent', { x: cx, y: cy, type: 'mouseMoved', button: 'none', modifiers: 0 }, sid);
    return `Hovering over <${r.tag}> at CSS (${Math.round(cx)}, ${Math.round(cy)}) (${selector})`;
  }
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { ok: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  await cdp.send('Input.dispatchMouseEvent', { x: r.x, y: r.y, type: 'mouseMoved', button: 'none', modifiers: 0 }, sid);
  return `Hovering over <${r.tag}> at CSS (${Math.round(r.x)}, ${Math.round(r.y)})`;
}

async function waitForStr(cdp, sid, args, refMap, refState) {
  // Shared polling loop
  async function poll(jsExpr, formatResult, interval, timeoutMs, label) {
    const timeout = Math.min(Math.max(timeoutMs, 500), 300000);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = await evalStr(cdp, sid, jsExpr);
      if (found !== 'null' && found !== '') return formatResult(JSON.parse(found));
      await sleep(interval);
    }
    throw new Error(`Timeout: ${label} not found within ${timeout}ms`);
  }

  // --any-of: regex-OR text wait, returns the first matching alternative.
  if (args[0] === '--any-of') {
    const pattern = args[1];
    if (!pattern) throw new Error('Pattern required after --any-of (e.g. "win|lose|escape")');
    let scope = 'body';
    let timeoutMs = 30000;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--scope' || args[i] === '-s') scope = args[++i];
      else if (/^\d+$/.test(args[i])) timeoutMs = parseInt(args[i]);
    }
    const alternatives = pattern.split('|').filter(Boolean);
    if (alternatives.length === 0) throw new Error('--any-of pattern must contain at least one alternative');
    const altsJson = JSON.stringify(alternatives);
    return poll(
      `(function() {
        const el = document.querySelector(${JSON.stringify(scope)});
        if (!el) return null;
        const t = el.innerText || el.textContent || '';
        const alts = ${altsJson};
        for (const a of alts) {
          const idx = t.indexOf(a);
          if (idx !== -1) return { matched: a, snippet: t.substring(Math.max(0, idx - 20), idx + a.length + 60).trim(), len: t.length };
        }
        return null;
      })()`,
      r => `Found "${r.matched}" (page has ${r.len} chars): "...${r.snippet}..."`,
      400, timeoutMs, `any of [${alternatives.join(', ')}]`
    );
  }

  // --selector-stable: wait for selector's textContent to stop changing for stableMs.
  if (args[0] === '--selector-stable') {
    const selector = args[1];
    if (!selector) throw new Error('Selector required after --selector-stable');
    const stableMs = parseInt(args[2]) || 3000;
    const timeoutMs = parseInt(args[3]) || 30000;
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 500), 300000);
    let lastText = null;
    let stableSince = null;
    while (Date.now() < deadline) {
      const raw = await evalStr(cdp, sid, `(function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const t = el.innerText || el.textContent || '';
        return JSON.stringify({ len: t.length, hash: t });
      })()`);
      if (raw === 'null' || raw === '') {
        // selector not present yet — keep polling
        lastText = null; stableSince = null;
        await sleep(300);
        continue;
      }
      const cur = JSON.parse(raw);
      if (lastText !== null && cur.hash === lastText) {
        if (stableSince == null) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) {
          return `Selector "${selector}" stable for ${stableMs}ms (${cur.len} chars)`;
        }
      } else {
        lastText = cur.hash;
        stableSince = null;
      }
      await sleep(Math.min(300, stableMs / 4));
    }
    throw new Error(`Timeout: "${selector}" did not stabilise within ${timeoutMs}ms`);
  }

  // --gone: wait for element to DISAPPEAR (e.g. stop button after streaming)
  if (args[0] === '--gone') {
    const selector = args[1];
    if (!selector) throw new Error('CSS selector or @ref required after --gone');
    const timeoutMs = parseInt(args[2]) || 30000;
    const timeout = Math.min(Math.max(timeoutMs, 500), 300000);
    const deadline = Date.now() + timeout;

    // Resolve @ref to a JS check via backendNodeId
    if (isRef(selector) && refMap) {
      const num = parseInt(selector.slice(1));
      const backendNodeId = refMap.get(num);
      if (!backendNodeId) throw new Error(formatUnknownRefError(selector, refState || {}));
      while (Date.now() < deadline) {
        try {
          const { object } = await cdp.send('DOM.resolveNode', { backendNodeId }, sid);
          // Node still exists — check if it's connected and visible
          const res = await cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: `function() { return this.isConnected && this.offsetParent !== null; }`,
            returnByValue: true,
          }, sid);
          if (!res.result.value) return `Element ${selector} is gone (disconnected or hidden)`;
        } catch {
          return `Element ${selector} is gone (removed from DOM)`;
        }
        await sleep(300);
      }
      throw new Error(`Timeout: ${selector} still present after ${timeout}ms`);
    }

    // CSS selector mode
    while (Date.now() < deadline) {
      const found = await evalStr(cdp, sid, `document.querySelector(${JSON.stringify(selector)}) ? 'yes' : null`);
      if (found === 'null' || found === '') return `Element "${selector}" is gone`;
      await sleep(300);
    }
    throw new Error(`Timeout: "${selector}" still present after ${timeout}ms`);
  }

  // Parse args: waitfor <selector> [timeout] OR waitfor --text <text> [--scope <sel>] [timeout]
  if (args[0] === '--text') {
    const text = args[1];
    if (!text) throw new Error('Text string required after --text');
    let scope = 'body';
    let timeoutMs = 30000;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--scope' || args[i] === '-s') scope = args[++i];
      else timeoutMs = parseInt(args[i]) || 30000;
    }
    return poll(
      `(function() {
        const el = document.querySelector(${JSON.stringify(scope)});
        if (!el) return null;
        const t = el.innerText;
        const idx = t.indexOf(${JSON.stringify(text)});
        if (idx === -1) return null;
        return { len: t.length, snippet: t.substring(Math.max(0, idx - 20), idx + ${text.length} + 80).trim() };
      })()`,
      r => `Found text (page has ${r.len} chars): "...${r.snippet}..."`,
      500, timeoutMs, `text "${text}"`
    );
  }
  // CSS selector mode
  const selector = args[0];
  if (!selector) throw new Error('CSS selector or --text required');
  const timeoutMs = parseInt(args[1]) || 10000;
  try {
    return await poll(
      `(function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        return { tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
      })()`,
      r => `Found <${r.tag}> "${r.text}"`,
      200, timeoutMs, `"${selector}"`
    );
  } catch (e) {
    throw new Error(e.message + ' — to wait for specific text content instead, use: waitfor --text "expected text" 120000');
  }
}

function formatInputTextPreview(text) {
  return `${text.substring(0, 40)}${text.length > 40 ? '...' : ''}`;
}

async function fillReactStr(cdp, sid, selector, text, refMap, refState) {
  const objectId = isRef(selector)
    ? await resolveRefNode(cdp, sid, refMap, selector, refState)
    : await resolveSelectorNode(cdp, sid, selector);
  const res = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(value) {
      const el = this;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      if (el.isContentEditable) {
        el.textContent = value;
      } else {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
          || Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, value);
        else el.value = value;
      }
      const inputEvent = typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: value })
        : new Event('input', { bubbles: true, cancelable: true });
      el.dispatchEvent(inputEvent);
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return { tag: el.tagName, value: el.isContentEditable ? el.textContent : el.value };
    }`,
    arguments: [{ value: text }],
    returnByValue: true,
  }, sid);
  const tag = res.result.value?.tag || '?';
  return `React-filled ${isRef(selector) ? selector : `<${tag}>`} with "${formatInputTextPreview(text)}"`;
}

async function fillStr(cdp, sid, selector, text, refMap, refState, opts = {}) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (text == null) throw new Error('Text required');
  if (opts.react) return fillReactStr(cdp, sid, selector, text, refMap, refState);
  if (isRef(selector)) {
    const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState);
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() { this.scrollIntoView({block:'center'}); this.focus(); this.value=''; this.dispatchEvent(new Event('input',{bubbles:true})); }`,
      returnByValue: true,
    }, sid);
    await cdp.send('Input.insertText', { text }, sid);
    return `Filled ${selector} with "${formatInputTextPreview(text)}"`;
  }
  // Focus via JS (more reliable than mouse events for input focus) + get element info
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, tag: el.tagName };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  // Insert text into the now-focused, cleared field
  await cdp.send('Input.insertText', { text }, sid);
  return `Filled <${r.tag}> with "${formatInputTextPreview(text)}"`;
}

async function selectStr(cdp, sid, selector, value) {
  if (!selector) throw new Error('CSS selector required');
  if (value == null) throw new Error('Value required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      if (el.tagName !== 'SELECT') return { ok: false, error: 'Not a <select>: ' + el.tagName };
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const opt = el.options[el.selectedIndex];
      return { ok: true, text: opt ? opt.textContent.trim() : value };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Selected "${r.text}"`;
}

async function fullshotStr(cdp, sid, filePath, targetId) {
  const dpr = await getDpr(cdp, sid);
  const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
  const width = metrics.cssContentSize?.width || metrics.contentSize?.width || 1280;
  const height = metrics.cssContentSize?.height || metrics.contentSize?.height || 800;

  const clip = { x: 0, y: 0, width, height, scale: 1 };
  const { data, fallback } = await captureScreenshot(cdp, sid, {
    format: 'png', captureBeyondViewport: true, clip,
  }, clip);

  const out = filePath || resolve(RUNTIME_DIR, `fullshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  const fb = fallback ? ' (screenshot fallback — Page.captureScreenshot not available)' : '';
  return `${out}\nFull-page screenshot saved. Size: ${width}x${height} CSS px, DPR: ${dpr}${fb}\nNote: large pages produce tiny text. Use 'scanshot' for readable segmented capture.`;
}

async function scanshotStr(cdp, sid, targetId) {
  // Get viewport and page dimensions
  const dims = await evalStr(cdp, sid, `JSON.stringify({
    vw: window.innerWidth, vh: window.innerHeight,
    scrollH: document.documentElement.scrollHeight,
    scrollY: Math.round(window.scrollY)
  })`);
  const { vw, vh, scrollH, scrollY: originalY } = JSON.parse(dims);

  // Calculate segments (overlap by 10% to avoid cutting content at boundaries)
  const overlap = Math.round(vh * 0.1);
  const step = vh - overlap;
  const segments = [];
  for (let y = 0; y < scrollH; y += step) {
    segments.push(y);
  }
  // If the last segment is tiny (< 30% viewport), replace it with a
  // bottom-aligned capture so no content is clipped
  if (segments.length > 1) {
    const lastY = segments[segments.length - 1];
    const lastH = scrollH - lastY;
    if (lastH < vh * 0.3) {
      segments.pop();
      // Scroll the last capture so the viewport's bottom edge aligns with page bottom
      const bottomY = Math.max(0, scrollH - vh);
      if (bottomY > segments[segments.length - 1]) {
        segments.push(bottomY);
      }
    }
  }

  const files = [];
  const prefix = (targetId || 'unknown').slice(0, 8);

  let usedFallback = false;
  for (let i = 0; i < segments.length; i++) {
    const y = segments[i];
    // Scroll to segment
    await evalStr(cdp, sid, `window.scrollTo(0, ${y})`);
    await sleep(150); // let rendering settle

    const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png' });
    if (fallback) usedFallback = true;
    const out = resolve(RUNTIME_DIR, `scanshot-${prefix}-${i + 1}.png`);
    writeFileSync(out, Buffer.from(data, 'base64'));
    files.push(out);
  }

  // Restore original scroll position
  await evalStr(cdp, sid, `window.scrollTo(0, ${originalY})`);

  const lines = [`Captured ${files.length} segment(s) of ${vw}x${vh} viewport (page height: ${scrollH}px)`];
  if (usedFallback) lines.push(`(screenshot fallback — Page.captureScreenshot not available)`);
  for (let i = 0; i < files.length; i++) {
    lines.push(`  [${i + 1}/${files.length}] ${files[i]}`);
  }
  lines.push(`Use the Read tool to view each segment image.`);
  return lines.join('\n');
}

async function stylesStr(cdp, sid, selectorOrArgs) {
  // Share root/selector resolution with text/html for consistent diagnostics.
  let opts;
  if (Array.isArray(selectorOrArgs)) opts = parseTextArgs(selectorOrArgs);
  else if (typeof selectorOrArgs === 'string' || selectorOrArgs == null) {
    opts = parseTextArgs(selectorOrArgs ? [selectorOrArgs] : []);
  } else opts = { selectors: [], root: null };
  const selector = opts.selectors[0] || null;
  if (!selector) throw new Error('CSS selector required');
  const root = opts.root || 'document';
  const expr = `
    (function() {
      function safeQuery(root, sel) { try { return root?.querySelector?.(sel) || null; } catch { return null; } }
      let scope = document.documentElement;
      const rootSetting = ${JSON.stringify(root)};
      if (rootSetting === 'body') scope = document.body || document.documentElement;
      else if (rootSetting === 'auto' || rootSetting === 'default') {
        scope = safeQuery(document, '#root') || safeQuery(document, '[data-reactroot]') || safeQuery(document, 'main') || document.body || document.documentElement;
      } else if (rootSetting !== 'document') {
        scope = safeQuery(document, rootSetting);
        if (!scope) return JSON.stringify({ ok: false, root: rootSetting, reason: 'root-not-found' });
      }
      const el = scope === document || scope === document.documentElement
        ? safeQuery(document, ${JSON.stringify(selector)})
        : (scope.matches && scope.matches(${JSON.stringify(selector)}) ? scope : safeQuery(scope, ${JSON.stringify(selector)}));
      if (!el) return JSON.stringify({ ok: false, root: rootSetting, selector: ${JSON.stringify(selector)} });
      const cs = window.getComputedStyle(el);
      const props = {};
      const keep = [
        'display','visibility','opacity','position','top','right','bottom','left',
        'width','height','min-width','min-height','max-width','max-height',
        'margin','padding','border','box-sizing','overflow','z-index',
        'flex','flex-direction','flex-wrap','align-items','justify-content','gap',
        'grid-template-columns','grid-template-rows',
        'color','background-color','background','font-size','font-weight','font-family',
        'line-height','text-align','text-decoration','text-overflow','white-space',
        'transform','transition','animation','cursor','pointer-events','user-select',
        'box-shadow','border-radius','outline',
      ];
      const skip = new Set([
        'none','normal','auto','0px','0','visible','static','content-box',
        'start','baseline','inherit','default','clip','row','nowrap',
        'rgb(0, 0, 0)','rgba(0, 0, 0, 0)',
      ]);
      const skipPatterns = [
        /^0px /,
        /^rgba\\(0, ?0, ?0, ?0\\)/,
        /^0 [01]+ auto$/,
        /none 0px$/,
        /^all$/,
      ];
      for (const p of keep) {
        const v = cs.getPropertyValue(p);
        if (!v || skip.has(v)) continue;
        if (skipPatterns.some(re => re.test(v))) continue;
        props[p] = v;
      }
      return JSON.stringify({
        ok: true,
        root: rootSetting,
        tag: el.tagName,
        id: el.id,
        cls: el.className?.toString().substring(0, 80),
        props,
      });
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  let parsed;
  try { parsed = JSON.parse(result); } catch { parsed = null; }
  if (!parsed || parsed.ok === false) {
    const rootLabel = parsed?.root || root || 'document';
    throw new Error(
      `styles: no element matched within root "${rootLabel}" for selector ${selector}. ` +
      `Fallback: cdp eval <target> "getComputedStyle(document.querySelector(${JSON.stringify(selector)}))"`
    );
  }
  // Legacy path: eval may still return a plain object if script changes.
  const r = typeof parsed === 'object' && parsed.props ? parsed : JSON.parse(result);
  const header = '<' + r.tag + '>' + (r.id ? '#' + r.id : '') + (r.cls ? '.' + r.cls.split(' ').join('.') : '');
  const lines = [header];
  for (const [k, v] of Object.entries(r.props || {})) {
    lines.push('  ' + k + ': ' + v);
  }
  return lines.join('\n');
}


// ---------------------------------------------------------------------------
// components — React/Vue component tree + state (MVP)
// ---------------------------------------------------------------------------

function parseComponentsArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = {
    format: fopts.format,
    depth: 6,
    ref: null,
    selector: null,
    unsafeFull: false,
    maxChars: 2000,
  };
  const positional = [];
  for (let i = 0; i < fopts.args.length; i++) {
    const a = fopts.args[i];
    if (a === '--depth' || a === '-d') {
      const n = parseInt(fopts.args[++i], 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error('components: --depth requires a positive integer');
      opts.depth = Math.min(n, 20);
    } else if (a === '--unsafe-full') {
      opts.unsafeFull = true;
    } else if (a === '--max-chars') {
      const n = Number(fopts.args[++i]);
      if (!Number.isInteger(n) || n < 80 || n > 20000) {
        throw new Error('components: --max-chars requires an integer between 80 and 20000');
      }
      opts.maxChars = n;
    } else if (/^@(?:\d+|c\d+|f\d+:\d+)$/.test(String(a))) {
      opts.ref = a;
    } else if (String(a).startsWith('@')) {
      throw new Error(`components: invalid ref ${a}`);
    } else if (String(a).startsWith('-')) {
      throw new Error(`components: unknown argument ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (!opts.ref && positional[0]) {
    opts.selector = positional[0];
  }
  return opts;
}

function sanitizeComponentValue(value, { unsafeFull = false, maxChars = 2000 } = {}) {
  const safeValue = unsafeFull ? value : redactSensitiveArtifactValue(value);
  let serialized;
  try {
    serialized = JSON.stringify(safeValue);
  } catch {
    serialized = String(safeValue);
  }
  if (serialized === undefined) serialized = 'undefined';
  const originalChars = serialized.length;
  if (unsafeFull || originalChars <= maxChars) {
    return { value: safeValue, truncated: false, originalChars };
  }
  return {
    value: {
      truncated: true,
      originalChars,
      preview: serialized.slice(0, maxChars),
    },
    truncated: true,
    originalChars,
  };
}

function sanitizeComponentResult(parsed = {}, opts = {}) {
  if (!parsed?.ok) return parsed;
  const props = sanitizeComponentValue(parsed.props || {}, opts);
  const state = sanitizeComponentValue(parsed.state || {}, opts);
  return {
    ...parsed,
    props: props.value,
    state: state.value,
    privacy: {
      redaction: opts.unsafeFull ? 'unsafe-full' : 'default-redacted',
    },
    limits: {
      maxCharsPerSection: opts.unsafeFull ? null : opts.maxChars,
      props: { truncated: props.truncated, originalChars: props.originalChars },
      state: { truncated: state.truncated, originalChars: state.originalChars },
    },
  };
}

function frameworkDetectorScript() {
  return `(function() {
    try {
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook?.renderers?.size > 0) {
        const renderer = Array.from(hook.renderers.values())[0];
        return JSON.stringify({ framework: 'react', version: renderer?.version || 'unknown', source: 'devtools-hook' });
      }
    } catch {}
    try {
      if (window.__VUE__) return JSON.stringify({ framework: 'vue', version: window.__VUE__.version || 'unknown', source: '__VUE__' });
    } catch {}
    try {
      const vueApp = document.querySelector('#app')?.__vue_app__ || document.querySelector('[data-v-app]')?.__vue_app__;
      if (vueApp) return JSON.stringify({ framework: 'vue', version: vueApp.version || '3', source: 'vue_app' });
    } catch {}
    try {
      const el = document.querySelector('[ng-version]');
      if (el) return JSON.stringify({ framework: 'angular', version: el.getAttribute('ng-version') || 'unknown', source: 'ng-version' });
    } catch {}
    // Fiber present without DevTools hook (dev builds)
    try {
      const roots = document.querySelectorAll('[data-reactroot], #root, #__next, #app, [data-reactroot]');
      for (const root of roots) {
        const key = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (key) return JSON.stringify({ framework: 'react', version: 'fiber', source: 'fiber-key' });
      }
    } catch {}
    return JSON.stringify({ framework: null });
  })()`;
}

function componentTreeRedactionHelpersScript() {
  return `
    const sensitiveKey = key => /(?:pass(?:word)?|secret|token|api[_-]?key|auth|session|cookie|credential|private[_-]?key)/i.test(String(key || ''));
    function redactString(value) {
      return String(value)
        .replace(/(authorization\\s*[:=]\\s*(?:bearer\\s+)?)[^\\s,;]+/ig, '$1[REDACTED]')
        .replace(/(bearer\\s+)[A-Za-z0-9._~+\\/=-]+/ig, '$1[REDACTED]');
    }
    function redactNested(value, key = '', depth = 0, seen = new WeakSet()) {
      if (sensitiveKey(key)) return '[REDACTED]';
      if (value == null) return value;
      if (typeof value === 'string') return redactString(value);
      if (typeof value !== 'object') return value;
      if (seen.has(value)) return '[circular]';
      if (depth >= 4) return '[nested]';
      seen.add(value);
      if (Array.isArray(value)) return value.slice(0, 20).map(item => redactNested(item, '', depth + 1, seen));
      const out = {};
      for (const [entryKey, entryValue] of Object.entries(value).slice(0, 20)) {
        out[entryKey] = redactNested(entryValue, entryKey, depth + 1, seen);
      }
      return out;
    }
  `;
}

function reactComponentsTreeScript(maxDepth = 6, { redactSensitive = true } = {}) {
  return `(function() {
    const maxDepth = ${Number(maxDepth) || 6};
    const redactSensitive = ${redactSensitive ? 'true' : 'false'};
    ${componentTreeRedactionHelpersScript()}
    function safeName(type) {
      if (!type) return null;
      if (typeof type === 'string') return type;
      return type.displayName || type.name || null;
    }
    function summarizeProps(props) {
      if (!props || typeof props !== 'object') return '';
      const parts = [];
      for (const [k, v] of Object.entries(props)) {
        if (k === 'children' || typeof v === 'function') continue;
        let s;
        try {
          const safeValue = redactSensitive ? redactNested(v, k) : v;
          s = typeof safeValue === 'string' ? JSON.stringify(safeValue) : (typeof safeValue === 'object' ? JSON.stringify(safeValue) : String(safeValue));
        }
        catch { s = '[unserializable]'; }
        if (s.length > 40) s = s.slice(0, 37) + '...';
        parts.push(k + '=' + s);
        if (parts.length >= 4) { parts.push('...'); break; }
      }
      return parts.length ? ' ' + parts.join(' ') : '';
    }
    function walk(fiber, depth, lines, seen) {
      if (!fiber || depth > maxDepth) return;
      const id = fiber._debugID || fiber.actualStartTime || Math.random();
      if (seen.has(fiber)) return;
      seen.add(fiber);
      const name = safeName(fiber.type);
      if (name && name.length <= 60 && !/^[a-z]/.test(name)) {
        lines.push('  '.repeat(depth) + '<' + name + summarizeProps(fiber.memoizedProps) + '>');
        if (fiber.child) walk(fiber.child, depth + 1, lines, seen);
      } else {
        if (fiber.child) walk(fiber.child, depth, lines, seen);
      }
      if (fiber.sibling) walk(fiber.sibling, depth, lines, seen);
    }
    const roots = document.querySelectorAll('[data-reactroot], #root, #__next, #app, body > div');
    for (const root of roots) {
      const key = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!key) continue;
      let fiber = root[key];
      // Climb to root fiber
      let guard = 0;
      while (fiber?.return && guard++ < 50) fiber = fiber.return;
      const lines = [];
      walk(fiber, 0, lines, new Set());
      if (lines.length) {
        return JSON.stringify({ ok: true, framework: 'react', lines: lines.slice(0, 200), truncated: lines.length > 200 });
      }
    }
    return JSON.stringify({ ok: false, framework: 'react', reason: 'fiber-tree-not-found' });
  })()`;
}

function vueComponentsTreeScript(maxDepth = 6, { redactSensitive = true } = {}) {
  return `(function() {
    const maxDepth = ${Number(maxDepth) || 6};
    const redactSensitive = ${redactSensitive ? 'true' : 'false'};
    ${componentTreeRedactionHelpersScript()}
    function walk(vm, depth, lines) {
      if (!vm || depth > maxDepth) return;
      const name = vm.$options?.name || vm.type?.name || vm.$.type?.name || 'Anonymous';
      const props = vm.$props || vm.props || {};
      const propParts = [];
      try {
        for (const [k, v] of Object.entries(props || {})) {
          if (typeof v === 'function') continue;
          const safeValue = redactSensitive ? redactNested(v, k) : v;
          let s = typeof safeValue === 'object' ? JSON.stringify(safeValue) : String(safeValue);
          if (s.length > 30) s = s.slice(0, 27) + '...';
          propParts.push(k + '=' + s);
          if (propParts.length >= 3) break;
        }
      } catch {}
      lines.push('  '.repeat(depth) + '<' + name + (propParts.length ? ' ' + propParts.join(' ') : '') + '>');
      const children = vm.$children || vm.subTree?.component?.subTree?.children || [];
      if (Array.isArray(children)) {
        for (const child of children) {
          const next = child?.component || child;
          if (next) walk(next, depth + 1, lines);
        }
      }
    }
    const lines = [];
    const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
    const app = appEl?.__vue_app__;
    if (app?._instance) {
      walk(app._instance, 0, lines);
    } else if (appEl?.__vue__) {
      walk(appEl.__vue__, 0, lines);
    }
    if (!lines.length) return JSON.stringify({ ok: false, framework: 'vue', reason: 'vue-tree-not-found' });
    return JSON.stringify({ ok: true, framework: 'vue', lines: lines.slice(0, 200), truncated: lines.length > 200 });
  })()`;
}

function reactComponentAtElementScript() {
  return `function(el) {
    if (!el) return JSON.stringify({ ok: false, reason: 'no-element' });
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!key) return JSON.stringify({ ok: false, reason: 'no-fiber-on-element' });
    let fiber = el[key];
    let guard = 0;
    while (fiber && guard++ < 40) {
      const name = fiber.type?.displayName || fiber.type?.name;
      if (typeof name === 'string' && name.length && name[0] === name[0].toUpperCase()) {
        const props = {};
        try {
          for (const [k, v] of Object.entries(fiber.memoizedProps || {})) {
            if (k === 'children' || typeof v === 'function') continue;
            try { props[k] = typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }
            catch { props[k] = String(v).slice(0, 80); }
            if (Object.keys(props).length >= 12) break;
          }
        } catch {}
        const state = {};
        try {
          let hook = fiber.memoizedState;
          let i = 0;
          while (hook && i < 8) {
            if (hook.memoizedState !== undefined && typeof hook.memoizedState !== 'function') {
              try { state['hook' + i] = JSON.parse(JSON.stringify(hook.memoizedState)); }
              catch { state['hook' + i] = String(hook.memoizedState).slice(0, 80); }
            }
            hook = hook.next;
            i++;
          }
        } catch {}
        return JSON.stringify({ ok: true, name, props, state });
      }
      fiber = fiber.return;
    }
    return JSON.stringify({ ok: false, reason: 'no-named-component' });
  }`;
}

async function resolveComponentRefObjectId(cdp, sid, ref, refMap, refState) {
  if (!isCursorRef(ref)) return resolveRefNode(cdp, sid, refMap, ref, refState);
  const rect = resolveCursorRef(refMap, ref, refState);
  const result = await cdp.send('Runtime.evaluate', {
    expression: `document.elementFromPoint(${rect.x + rect.w / 2}, ${rect.y + rect.h / 2})`,
    returnByValue: false,
    awaitPromise: false,
  }, sid, REF_RESOLVE_TIMEOUT);
  if (result.exceptionDetails) throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  const objectId = result.result?.objectId;
  if (!objectId) throw new Error(`Unknown cursor ref: ${ref}. Run "perceive -C -d 8" to refresh cursor refs, or use a stable CSS selector.`);
  return objectId;
}

async function componentsStr(cdp, sid, args = [], refMap = new Map(), refState = null) {
  const opts = parseComponentsArgs(args);
  const detectionRaw = await evalStr(cdp, sid, frameworkDetectorScript());
  let detection;
  try { detection = JSON.parse(detectionRaw); } catch { detection = { framework: null }; }
  if (!detection.framework) {
    const msg = 'No supported framework detected (React fiber/DevTools, Vue, or Angular ng-version).';
    return opts.format === 'json'
      ? formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: null, ok: false, message: msg })
      : msg;
  }
  if (detection.framework === 'angular') {
    const msg = `Angular ${detection.version} detected; tree extraction not yet supported. Use eval for ng probes.`;
    return opts.format === 'json'
      ? formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: 'angular', version: detection.version, ok: false, message: msg })
      : msg;
  }

  if ((opts.ref || opts.selector) && detection.framework !== 'react') {
    const target = opts.ref || opts.selector;
    const reason = 'target-inspection-unsupported';
    const message = `Targeted component props/state inspection is not supported for ${detection.framework}; inspect the component tree or use a React dev build.`;
    return opts.format === 'json'
      ? formatJson({
          schema: 'chrome-cdp-ex.components.v1',
          framework: detection.framework,
          version: detection.version,
          target,
          ok: false,
          reason,
          message,
        })
      : `components: ${message}`;
  }

  if (opts.ref || opts.selector) {
    if (opts.ref) {
      try {
        const objectId = await resolveComponentRefObjectId(cdp, sid, opts.ref, refMap, refState);
        if (objectId && detection.framework === 'react') {
            const result = await cdp.send('Runtime.callFunctionOn', {
              objectId,
              functionDeclaration: `function() { return (${reactComponentAtElementScript()})(this); }`,
              returnByValue: true,
            }, sid);
            if (result.exceptionDetails) throw new Error(runtimeExceptionMessage(result.exceptionDetails));
            let parsed;
            try { parsed = JSON.parse(result.result?.value || '{}'); } catch { parsed = { ok: false }; }
            parsed = sanitizeComponentResult(parsed, opts);
            if (opts.format === 'json') {
              return formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: detection.framework, version: detection.version, target: opts.ref, ...parsed });
            }
            if (!parsed.ok) return `components: could not resolve component for ${opts.ref} (${parsed.reason || 'unknown'})`;
            const lines = [`Component: <${parsed.name}>`];
            lines.push(`  Props: ${JSON.stringify(parsed.props || {})}`);
            lines.push(`  State/hooks: ${JSON.stringify(parsed.state || {})}`);
            return lines.join('\n');
        }
      } catch (e) {
        if (opts.format === 'json') {
          return formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: detection.framework, ok: false, error: e.message });
        }
        return `components: ${e.message}`;
      }
    }
    if (opts.selector) {
      const raw = await evalStr(cdp, sid, `(${reactComponentAtElementScript()})(document.querySelector(${JSON.stringify(opts.selector)}))`);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = { ok: false, reason: 'parse-failed' }; }
      parsed = sanitizeComponentResult(parsed, opts);
      if (opts.format === 'json') {
        return formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: detection.framework, version: detection.version, target: opts.selector, ...parsed });
      }
      if (!parsed.ok) return `components: could not resolve component for ${opts.selector} (${parsed.reason || 'unknown'})`;
      return [`Component: <${parsed.name}>`, `  Props: ${JSON.stringify(parsed.props || {})}`, `  State/hooks: ${JSON.stringify(parsed.state || {})}`].join('\n');
    }
  }

  const treeRaw = detection.framework === 'vue'
    ? await evalStr(cdp, sid, vueComponentsTreeScript(opts.depth, { redactSensitive: !opts.unsafeFull }))
    : await evalStr(cdp, sid, reactComponentsTreeScript(opts.depth, { redactSensitive: !opts.unsafeFull }));
  let tree;
  try { tree = JSON.parse(treeRaw); } catch { tree = { ok: false, reason: 'parse-failed' }; }
  if (opts.format === 'json') {
    return formatJson({
      schema: 'chrome-cdp-ex.components.v1',
      framework: detection.framework,
      version: detection.version,
      source: detection.source,
      depth: opts.depth,
      privacy: { redaction: opts.unsafeFull ? 'unsafe-full' : 'default-redacted' },
      ...tree,
    });
  }
  if (!tree.ok) {
    return `${detection.framework} ${detection.version || ''} detected but component tree not found (${tree.reason || 'unknown'}). Use a dev build or framework DevTools hooks.`.replace(/\\s+/g, ' ').trim();
  }
  const header = `[${detection.framework} ${detection.version || ''} detected]`;
  return [header, '', ...(tree.lines || []), tree.truncated ? `... truncated` : null].filter(Boolean).join('\n');
}

async function cookiesStr(cdp, sid) {
  const { cookies } = await cdp.send('Network.getCookies', {}, sid);
  if (!cookies || cookies.length === 0) return 'No cookies';
  // Dynamic column width based on actual cookie names
  const nameW = Math.min(Math.max(...cookies.map(c => c.name.length)) + 2, 32);
  const lines = [];
  for (const c of cookies) {
    const val = c.value.length > 30 ? c.value.substring(0, 30) + '...' : c.value;
    const flags = [c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite].filter(Boolean).join(' ');
    const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 19) : 'session';
    lines.push(`${c.name.padEnd(nameW)} ${val.padEnd(34)} ${c.domain.padEnd(20)} ${exp.padEnd(20)} ${flags}`);
  }
  return lines.join('\n');
}

// Checkpoint/restore: serialize the minimum browser state needed to resume a
// real-page exploration flow without pretending to snapshot the whole browser.
function checkpointPageScript() {
  return `(function() {
    function dumpStorage(storage) {
      const out = {};
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        out[key] = storage.getItem(key);
      }
      return out;
    }
    return JSON.stringify({
      url: location.href,
      title: document.title,
      origin: location.origin,
      localStorage: dumpStorage(localStorage),
      sessionStorage: dumpStorage(sessionStorage)
    });
  })()`;
}

function sanitizeCheckpointCookies(cookies = [], { redactValues = true } = {}) {
  return cookies.map(cookie => {
    const out = {};
    for (const key of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite']) {
      if (cookie[key] !== undefined) out[key] = key === 'value' && redactValues ? REDACTED_VALUE : cookie[key];
    }
    if (Number.isFinite(cookie.expires) && cookie.expires > 0) out.expires = cookie.expires;
    if (redactValues && out.value !== undefined) out.redacted = ['value'];
    return out;
  }).filter(cookie => cookie.name);
}

function sanitizeCheckpointStorage(storage = {}, { redactValues = true } = {}) {
  if (!storage || typeof storage !== 'object') return {};
  if (!redactValues) return { ...storage };
  return Object.fromEntries(Object.entries(storage).map(([key, value]) => [
    key,
    isSensitiveDataKey(key) ? REDACTED_VALUE : redactSensitiveArtifactValue(value, key),
  ]));
}

function parseCheckpointArgs(args = []) {
  const rest = [];
  let unsafeFullCapture = false;
  for (const arg of args || []) {
    if (arg === '--unsafe-full' || arg === '--full' || arg === '--include-secrets') {
      unsafeFullCapture = true;
    } else {
      rest.push(arg);
    }
  }
  return { unsafeFullCapture, args: rest };
}

async function checkpointModel(cdp, sid, { now = Date.now(), unsafeFullCapture = false } = {}) {
  const raw = await evalStr(cdp, sid, checkpointPageScript());
  let pageState;
  try {
    pageState = JSON.parse(raw);
  } catch (e) {
    throw new Error(`checkpoint: failed to read page state (${e.message})`);
  }
  let cookies = [];
  try {
    const res = await cdp.send('Network.getCookies', {}, sid);
    cookies = sanitizeCheckpointCookies(res.cookies || [], { redactValues: !unsafeFullCapture });
  } catch {}
  return {
    schema: 'chrome-cdp-ex.checkpoint.v1',
    ts: now,
    privacy: {
      redaction: unsafeFullCapture ? 'unsafe-full' : 'default-redacted',
      cookies: !unsafeFullCapture,
      storage: !unsafeFullCapture,
      warning: unsafeFullCapture
        ? 'This checkpoint intentionally includes raw cookie and storage values. Treat it as a secret artifact.'
        : 'Cookie values and sensitive storage values are redacted by default. Use --unsafe-full only when restore fidelity is required and the artifact can be protected.',
    },
    page: {
      url: pageState.url || '',
      title: pageState.title || '',
      origin: pageState.origin || '',
    },
    storage: {
      localStorage: sanitizeCheckpointStorage(pageState.localStorage || {}, { redactValues: !unsafeFullCapture }),
      sessionStorage: sanitizeCheckpointStorage(pageState.sessionStorage || {}, { redactValues: !unsafeFullCapture }),
    },
    cookies,
  };
}

async function checkpointStr(cdp, sid, { format = 'text', now = Date.now(), unsafeFullCapture = false } = {}) {
  const model = await checkpointModel(cdp, sid, { now, unsafeFullCapture });
  if (format === 'json') return formatJson(model);
  const localCount = Object.keys(model.storage.localStorage || {}).length;
  const sessionCount = Object.keys(model.storage.sessionStorage || {}).length;
  return [
    'Checkpoint captured',
    `URL: ${model.page.url}`,
    `Privacy: ${model.privacy.redaction}`,
    `Storage: local ${localCount}, session ${sessionCount}`,
    `Cookies: ${model.cookies.length}`,
    unsafeFullCapture
      ? 'Warning: raw cookie and storage values are included. Protect this artifact like a secret.'
      : 'Values: cookie values and sensitive storage values are redacted by default.',
    unsafeFullCapture
      ? 'Next: save `checkpoint --unsafe-full --format json` output and restore with `restore --file <path>`.'
      : 'Next: use `checkpoint --unsafe-full --format json` only when restore fidelity is required.',
  ].join('\n');
}

function parseCheckpointArtifact(raw) {
  let artifact;
  try {
    artifact = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error(`restore: invalid checkpoint JSON (${e.message})`);
  }
  if (!artifact || typeof artifact !== 'object') throw new Error('restore: checkpoint artifact must be a JSON object');
  if (artifact.schema !== 'chrome-cdp-ex.checkpoint.v1') {
    throw new Error(`restore: unsupported checkpoint schema ${artifact.schema || '(missing)'}`);
  }
  if (!artifact.page?.url) throw new Error('restore: checkpoint.page.url is required');
  validateUrl(artifact.page.url);
  return artifact;
}

function parseRestoreArgs(args, { reader = readFileSync } = {}) {
  const fopts = parseFormatArgs((args || []).filter(a => a !== undefined && a !== null), ['text', 'json']);
  const tokens = fopts.args;
  const positional = [];
  const finish = (result) => ({ ...result, format: fopts.format });
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--json') {
      const raw = tokens.slice(i + 1).join(' ').trim();
      if (!raw) throw new Error('restore --json requires a checkpoint JSON payload');
      return finish({ artifact: parseCheckpointArtifact(raw), source: 'inline JSON' });
    }
    if (token === '--file' || token === '-f') {
      const filePath = tokens[++i];
      if (!filePath) throw new Error('restore --file requires a checkpoint JSON path');
      return finish({ artifact: parseCheckpointArtifact(reader(filePath, 'utf8')), source: filePath });
    }
    positional.push(token);
  }
  const raw = positional.join(' ').trim();
  if (!raw) throw new Error('restore requires --file <path> or --json <checkpoint-json>');
  if (raw.startsWith('{')) return finish({ artifact: parseCheckpointArtifact(raw), source: 'inline JSON' });
  return finish({ artifact: parseCheckpointArtifact(reader(positional[0], 'utf8')), source: positional[0] });
}

function redactRestoreCommandArgs(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    out.push(arg);
    if (arg === '--json') {
      out.push('[checkpoint-json-redacted]');
      break;
    }
    if (arg === '--file' || arg === '-f') {
      if (args[i + 1]) out.push(args[++i]);
    }
  }
  return out.length ? out : ['restore'];
}

function checkpointCookieToSetCookieParams(cookie, url) {
  const params = { url };
  for (const key of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires']) {
    if (cookie[key] !== undefined) params[key] = cookie[key];
  }
  return params;
}

function restoreStorageScript(storage = {}) {
  const local = storage.localStorage || {};
  const session = storage.sessionStorage || {};
  return `(function() {
    const localItems = ${JSON.stringify(local)};
    const sessionItems = ${JSON.stringify(session)};
    localStorage.clear();
    for (const [key, value] of Object.entries(localItems)) localStorage.setItem(key, value);
    sessionStorage.clear();
    for (const [key, value] of Object.entries(sessionItems)) sessionStorage.setItem(key, value);
    return JSON.stringify({ localStorage: Object.keys(localItems).length, sessionStorage: Object.keys(sessionItems).length });
  })()`;
}

async function navigateForRestore(cdp, sid, url) {
  await cdp.send('Page.enable', {}, sid).catch(() => {});
  let loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  try {
    const nav = await cdp.send('Page.navigate', { url }, sid, 5000);
    if (nav.errorText) {
      loadEvent.cancel();
      throw new Error(nav.errorText);
    }
    if (nav.loaderId) {
      await loadEvent.promise;
    } else {
      loadEvent.cancel();
    }
    return 'Page.navigate';
  } catch (e) {
    loadEvent.cancel();
    if (!isTimeoutError(e, ['Page.navigate'])) throw e;
    loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
    await evalStr(cdp, sid, `(function() { location.assign(${JSON.stringify(url)}); return 'navigating'; })()`);
    await loadEvent.promise.catch(() => {});
    return 'location.assign fallback';
  }
}

async function restoreCheckpointStr(cdp, sid, args) {
  const { artifact } = parseRestoreArgs(args);
  const url = artifact.page.url;
  const cookies = sanitizeCheckpointCookies(artifact.cookies || []);
  let cookieSet = 0;
  for (const cookie of cookies) {
    const result = await cdp.send('Network.setCookie', checkpointCookieToSetCookieParams(cookie, url), sid);
    if (result && result.success === false) throw new Error(`restore: failed to set cookie ${cookie.name}`);
    cookieSet++;
  }

  let currentUrl = null;
  try { currentUrl = await evalStr(cdp, sid, 'location.href'); } catch {}
  const navigationMethod = currentUrl === url
    ? 'already at checkpoint URL'
    : await navigateForRestore(cdp, sid, url);
  await evalStr(cdp, sid, restoreStorageScript(artifact.storage || {}));

  const localCount = Object.keys(artifact.storage?.localStorage || {}).length;
  const sessionCount = Object.keys(artifact.storage?.sessionStorage || {}).length;
  return [
    `Restored checkpoint: ${url}`,
    `Navigation: ${navigationMethod}`,
    `Storage: local ${localCount}, session ${sessionCount}; cookies: ${cookieSet}`,
    'Refs were invalidated; run `perceive` before using @refs again.',
  ].join('\n');
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
  while (Date.now() < deadline) {
    const expr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()
    `;
    const result = await evalStr(cdp, sid, expr);
    if (result === 'null' || result === '') break;
    const r = JSON.parse(result);
    await dispatchClick(cdp, sid, r.x, r.y);
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

async function annotshotStr(cdp, sid, targetId, refMap) {
  if (refMap.size === 0) throw new Error('No refs available. Run "perceive" first.');

  // Resolve all refs in parallel to get bounding rects
  const refEntries = [...refMap.entries()];
  const settled = await Promise.allSettled(refEntries.map(async ([num, backendNodeId]) => {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId }, sid);
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() { const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }`,
      returnByValue: true,
    }, sid);
    return { num, ...result.result.value };
  }));
  const entries = settled.filter(s => s.status === 'fulfilled').map(s => s.value);

  // Inject overlay + draw labels + screenshot + cleanup in try/finally
  await evalStr(cdp, sid, `(function() {
    const overlay = document.createElement('div');
    overlay.id = '__cdp_annot_overlay__';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';
    document.body.appendChild(overlay);
  })()`);

  try {
    await evalStr(cdp, sid, `(function() {
      const overlay = document.getElementById('__cdp_annot_overlay__');
      if (!overlay) return;
      const entries = ${JSON.stringify(entries)};
      for (const e of entries) {
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;border:2px solid red;pointer-events:none;' +
          'left:' + e.x + 'px;top:' + e.y + 'px;width:' + e.w + 'px;height:' + e.h + 'px;';
        const label = document.createElement('span');
        label.textContent = '@' + e.num;
        label.style.cssText = 'position:absolute;top:-16px;left:0;background:red;color:white;font:bold 11px monospace;padding:1px 3px;border-radius:2px;line-height:14px;';
        box.appendChild(label);
        overlay.appendChild(box);
      }
    })()`);

    await sleep(100);

    const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png' });
    const prefix = (targetId || 'unknown').slice(0, 8);
    const out = resolve(RUNTIME_DIR, `annotshot-${prefix}.png`);
    writeFileSync(out, Buffer.from(data, 'base64'));

    const fb = fallback ? ' (fallback)' : '';
    return `${out}\nAnnotated screenshot with ${entries.length} ref labels. Use refs (@1, @2...) from perceive output to identify elements.${fb}`;
  } finally {
    await evalStr(cdp, sid, `(function() { const el = document.getElementById('__cdp_annot_overlay__'); if (el) el.remove(); })()`).catch(() => {});
  }
}

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

function dialogStr(dialogBuf, dialogAutoAcceptRef, flag) {
  if (flag === 'accept') { dialogAutoAcceptRef.value = true; return 'Dialog auto-accept: ON (default)'; }
  if (flag === 'dismiss') { dialogAutoAcceptRef.value = false; return 'Dialog auto-accept: OFF (dialogs will be dismissed/rejected)'; }
  if (flag) throw new Error(`Unknown dialog flag: "${flag}". Use "accept" or "dismiss".`);
  const mode = dialogAutoAcceptRef.value ? 'ON' : 'OFF';
  const entries = dialogBuf.all();
  if (entries.length === 0) return `No dialogs recorded. Auto-accept: ${mode}`;
  const lines = [`Dialogs (${entries.length}, auto-accept: ${mode}):`];
  for (const e of entries) {
    const ago = Math.round((Date.now() - e.ts) / 1000);
    lines.push(`  [${e.type}] "${e.message}" (${ago}s ago)`);
  }
  return lines.join('\n');
}

function netlogStr(netReqBuf, flag) {
  if (flag === '--clear') { netReqBuf.clear(); return 'Network log cleared'; }
  const entries = netReqBuf.all();
  if (entries.length === 0) return 'No network requests captured (tracking action-relevant requests; static assets are skipped)';
  const lines = [`Network requests (${entries.length}):`];
  for (const e of entries) {
    const ago = Math.round((Date.now() - e.ts) / 1000);
    const size = e.size > 1024 ? `${(e.size / 1024).toFixed(1)}KB` : `${e.size}B`;
    lines.push(`  ${e.method} ${e.url} → ${e.status} (${e.duration}ms, ${size}) ${ago}s ago`);
  }
  return lines.join('\n');
}

function parseHttpStatus(value, label = '--status') {
  const status = Number(value);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`mock ${label} requires an HTTP status code from 100 to 599`);
  }
  return status;
}

function parseMockArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args || [];
  if (tokens.length === 0) return { mode: 'status', format: fopts.format };
  const mode = String(tokens[0] || '').toLowerCase();
  if (mode === 'clear' || mode === 'off' || mode === 'reset') {
    if (tokens.length > 1) throw new Error(`mock ${tokens[0]} does not accept extra arguments`);
    return { mode: 'clear', format: fopts.format };
  }
  if (mode !== 'add') {
    throw new Error(`Unknown mock command: ${tokens[0]}. Use add, clear, or no args for status.`);
  }
  const urlPattern = tokens[1];
  if (!urlPattern) throw new Error('mock add requires a URL pattern, e.g. **/api/items*');
  const rule = {
    id: `mock-${Date.now().toString(36)}`,
    urlPattern,
    method: null,
    status: 200,
    body: '',
    contentType: 'text/plain; charset=utf-8',
  };
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--status') rule.status = parseHttpStatus(tokens[++i], '--status');
    else if (token === '--body') rule.body = tokens[++i] ?? '';
    else if (token === '--content-type' || token === '--type') rule.contentType = tokens[++i] || rule.contentType;
    else if (token === '--method') rule.method = String(tokens[++i] || '').toUpperCase();
    else throw new Error(`mock add: unknown option ${token}`);
  }
  if (rule.method === '') rule.method = null;
  return { mode: 'add', format: fopts.format, rule };
}

function wildcardToRegExp(pattern) {
  const escaped = String(pattern || '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function mockRuleMatches(rule, request = {}) {
  if (!rule) return false;
  if (rule.method && String(request.method || '').toUpperCase() !== rule.method) return false;
  return wildcardToRegExp(rule.urlPattern).test(String(request.url || ''));
}

function findNetworkMockRule(session, request = {}) {
  return (session.networkMocks || []).find(rule => mockRuleMatches(rule, request));
}

function formatNetworkMocksSummary(session = {}) {
  const rules = session.networkMocks || [];
  if (rules.length === 0) return 'off';
  const first = rules[0];
  const hits = (session.networkMockHits || []).filter(hit => hit.ruleId === first.id).length;
  const suffix = rules.length > 1 ? ` (+${rules.length - 1} more)` : '';
  return `${rules.length} rule${rules.length === 1 ? '' : 's'} — ${first.urlPattern} -> ${first.status} (${hits} hit${hits === 1 ? '' : 's'})${suffix}`;
}

function buildMockModel(session, parsed) {
  const rules = session.networkMocks || [];
  const hits = session.networkMockHits || [];
  return {
    schema: 'chrome-cdp-ex.mock.v1',
    targetId: session.targetId,
    mode: parsed.mode,
    rules: rules.map(rule => ({
      id: rule.id,
      urlPattern: rule.urlPattern,
      method: rule.method,
      status: rule.status,
      contentType: rule.contentType,
      bodyBytes: Buffer.byteLength(rule.body || '', 'utf8'),
      hits: hits.filter(hit => hit.ruleId === rule.id).length,
    })),
    recentHits: hits.slice(-10),
  };
}

function formatMockText(model) {
  if (!model.rules.length) {
    return [
      'Network mock: off',
      `Next: cdp mock ${model.targetId} add "**/api/*" --status 503 --body '{"ok":false}' --content-type application/json`,
    ].join('\n');
  }
  const lines = [`Network mock: ${model.rules.length} rule${model.rules.length === 1 ? '' : 's'}`];
  for (const [i, rule] of model.rules.entries()) {
    const method = rule.method ? `${rule.method} ` : '';
    lines.push(`${i + 1}. ${method}${rule.urlPattern} -> ${rule.status} ${rule.contentType} (${rule.hits} hit${rule.hits === 1 ? '' : 's'})`);
  }
  if (model.recentHits.length) {
    const hit = model.recentHits[model.recentHits.length - 1];
    lines.push(`Last hit: ${hit.method} ${hit.url} -> ${hit.status}`);
  }
  lines.push(`Next: cdp mock ${model.targetId} clear`);
  return lines.join('\n');
}

async function applyNetworkMocks(cdp, sid, session) {
  const rules = session.networkMocks || [];
  if (!rules.length) {
    await cdp.send('Fetch.disable', {}, sid);
    return;
  }
  await cdp.send('Fetch.enable', {
    patterns: rules.map(rule => ({ urlPattern: rule.urlPattern, requestStage: 'Request' })),
  }, sid);
}

async function handleMockRequestPaused(cdp, sid, session, params = {}) {
  const request = params.request || {};
  const rule = findNetworkMockRule(session, request);
  if (!rule) {
    await cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sid);
    return null;
  }
  await cdp.send('Fetch.fulfillRequest', {
    requestId: params.requestId,
    responseCode: rule.status,
    responseHeaders: [{ name: 'content-type', value: rule.contentType }],
    body: Buffer.from(rule.body || '', 'utf8').toString('base64'),
  }, sid);
  const hit = {
    ruleId: rule.id,
    method: request.method || '',
    url: request.url || '',
    status: rule.status,
    ts: Date.now(),
  };
  session.networkMockHits.push(hit);
  if (session.networkMockHits.length > MAX_NETWORK_MOCK_HITS) {
    session.networkMockHits.splice(0, session.networkMockHits.length - MAX_NETWORK_MOCK_HITS);
  }
  return hit;
}

async function mockStr(cdp, sid, session, args = []) {
  const parsed = parseMockArgs(args);
  if (!Array.isArray(session.networkMocks)) session.networkMocks = [];
  if (!Array.isArray(session.networkMockHits)) session.networkMockHits = [];
  if (parsed.mode === 'add') {
    session.networkMocks.push(parsed.rule);
    await applyNetworkMocks(cdp, sid, session);
    appendSessionEnvironmentLog(session, { kind: 'mock', ts: Date.now(), action: 'add', rule: parsed.rule });
  } else if (parsed.mode === 'clear') {
    session.networkMocks = [];
    session.networkMockHits = [];
    await applyNetworkMocks(cdp, sid, session);
    appendSessionEnvironmentLog(session, { kind: 'mock', ts: Date.now(), action: 'clear' });
  }
  const model = buildMockModel(session, parsed);
  return parsed.format === 'json' ? formatJson(model) : formatMockText(model);
}

function parseClockTimestamp(value) {
  if (value == null || value === '') throw new Error('clock freeze requires --at <date|epoch-ms>');
  const numeric = Number(value);
  const atMs = Number.isFinite(numeric) ? numeric : Date.parse(String(value));
  if (!Number.isFinite(atMs)) throw new Error('clock freeze --at requires a valid date or epoch milliseconds');
  return atMs;
}

function parseClockOffsetMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) throw new Error('clock offset --ms requires a finite millisecond value');
  return ms;
}

function parseClockArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args || [];
  if (tokens.length === 0) return { mode: 'status', format: fopts.format };
  const cmd = String(tokens[0] || '').toLowerCase();
  if (cmd === 'reset' || cmd === 'off' || cmd === 'real') {
    if (tokens.length > 1) throw new Error(`clock ${tokens[0]} does not accept extra arguments`);
    return { mode: 'reset', format: fopts.format, profile: 'real' };
  }
  if (cmd === 'freeze') {
    let atMs = null;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '--at') atMs = parseClockTimestamp(tokens[++i]);
      else throw new Error(`clock freeze: unknown option ${token}`);
    }
    if (atMs == null) throw new Error('clock freeze requires --at <date|epoch-ms>');
    return { mode: 'apply', format: fopts.format, profile: 'freeze', atMs };
  }
  if (cmd === 'offset') {
    let offsetMs = null;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '--ms') offsetMs = parseClockOffsetMs(tokens[++i]);
      else if (token === '--seconds') offsetMs = parseClockOffsetMs(tokens[++i]) * 1000;
      else throw new Error(`clock offset: unknown option ${token}`);
    }
    if (offsetMs == null) throw new Error('clock offset requires --ms <milliseconds>');
    return { mode: 'apply', format: fopts.format, profile: 'offset', offsetMs };
  }
  throw new Error(`Unknown clock command: ${tokens[0]}. Use freeze, offset, reset, or no args for status.`);
}

function clockPageScript(config) {
  return `(${function installCdpClock(cfg) {
    const g = globalThis;
    const existing = g.__cdpClockOriginals;
    const originals = existing || {
      Date: g.Date,
      performanceNow: g.performance && typeof g.performance.now === 'function'
        ? g.performance.now.bind(g.performance)
        : null,
    };
    if (!existing) {
      Object.defineProperty(g, '__cdpClockOriginals', {
        value: originals,
        configurable: true,
        writable: true,
      });
    }

    if (cfg.profile === 'real' || cfg.mode === 'reset') {
      if (originals.Date) g.Date = originals.Date;
      if (g.performance && originals.performanceNow) {
        try {
          Object.defineProperty(g.performance, 'now', {
            value: originals.performanceNow,
            configurable: true,
          });
        } catch {}
      }
      try { delete g.__cdpClock; } catch {}
      return { ok: true, profile: 'real', now: originals.Date.now() };
    }

    const OriginalDate = originals.Date;
    const profile = cfg.profile;
    const atMs = Number(cfg.atMs);
    const offsetMs = Number(cfg.offsetMs || 0);
    const installedAtPerfMs = originals.performanceNow ? originals.performanceNow() : 0;
    const currentNow = () => profile === 'freeze' ? atMs : OriginalDate.now() + offsetMs;

    function MockDate(...args) {
      if (this instanceof MockDate) {
        return args.length ? new OriginalDate(...args) : new OriginalDate(currentNow());
      }
      return new OriginalDate(currentNow()).toString();
    }
    Object.setPrototypeOf(MockDate, OriginalDate);
    MockDate.prototype = OriginalDate.prototype;
    MockDate.now = currentNow;
    MockDate.parse = OriginalDate.parse.bind(OriginalDate);
    MockDate.UTC = OriginalDate.UTC.bind(OriginalDate);
    try { Object.defineProperty(MockDate, 'name', { value: 'Date', configurable: true }); } catch {}
    g.Date = MockDate;

    if (g.performance && originals.performanceNow) {
      try {
        Object.defineProperty(g.performance, 'now', {
          value: () => profile === 'freeze' ? installedAtPerfMs : originals.performanceNow() + offsetMs,
          configurable: true,
        });
      } catch {}
    }

    const now = currentNow();
    g.__cdpClock = {
      profile,
      atMs: profile === 'freeze' ? atMs : null,
      offsetMs: profile === 'offset' ? offsetMs : 0,
      iso: new OriginalDate(now).toISOString(),
    };
    return { ok: true, ...g.__cdpClock, now };
  }.toString()})(${JSON.stringify(config)});`;
}

function formatSignedMs(ms) {
  return `${ms >= 0 ? '+' : ''}${ms}ms`;
}

function formatClockSummary(clock = null) {
  if (!clock || clock.profile === 'real') return 'real time';
  if (clock.profile === 'freeze') return `frozen at ${new Date(clock.atMs).toISOString()}`;
  if (clock.profile === 'offset') return `offset ${formatSignedMs(clock.offsetMs || 0)}`;
  return 'real time';
}

function buildClockModel(session, parsed) {
  const clock = parsed.mode === 'status' ? session.clock : (session.clock || null);
  return {
    schema: 'chrome-cdp-ex.clock.v1',
    targetId: session.targetId,
    mode: parsed.mode,
    profile: clock?.profile || 'real',
    atMs: clock?.atMs ?? null,
    offsetMs: clock?.offsetMs ?? 0,
    scriptIdentifier: clock?.scriptIdentifier || null,
  };
}

function formatClockText(model) {
  const lines = [`Clock: ${formatClockSummary(model)}`];
  if (model.profile === 'real') {
    lines.push(`Next: cdp clock ${model.targetId} freeze --at 2020-01-02T03:04:05.000Z`);
    lines.push(`Next: cdp clock ${model.targetId} offset --ms 3600000`);
  } else {
    lines.push(`Next: cdp clock ${model.targetId} reset`);
  }
  return lines.join('\n');
}

async function removeClockScriptIfNeeded(cdp, sid, session) {
  const identifier = session.clock?.scriptIdentifier;
  if (identifier) {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sid);
  }
}

async function clockStr(cdp, sid, session, args = []) {
  const parsed = parseClockArgs(args);
  if (parsed.mode === 'apply') {
    await removeClockScriptIfNeeded(cdp, sid, session);
    const source = clockPageScript(parsed);
    const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sid);
    await cdp.send('Runtime.evaluate', { expression: source, returnByValue: true, awaitPromise: true }, sid);
    session.clock = {
      profile: parsed.profile,
      atMs: parsed.profile === 'freeze' ? parsed.atMs : null,
      offsetMs: parsed.profile === 'offset' ? parsed.offsetMs : 0,
      scriptIdentifier: added.identifier || null,
      appliedAt: Date.now(),
    };
    appendSessionEnvironmentLog(session, { kind: 'clock', ts: session.clock.appliedAt, action: 'apply', clock: session.clock });
  } else if (parsed.mode === 'reset') {
    await removeClockScriptIfNeeded(cdp, sid, session);
    await cdp.send('Runtime.evaluate', { expression: clockPageScript(parsed), returnByValue: true, awaitPromise: true }, sid);
    appendSessionEnvironmentLog(session, { kind: 'clock', ts: Date.now(), action: 'reset' });
    session.clock = null;
  }
  const model = buildClockModel(session, parsed);
  return parsed.format === 'json' ? formatJson(model) : formatClockText(model);
}

const THROTTLE_PRESETS = Object.freeze({
  off: { profile: 'off', offline: false, latencyMs: 0, downloadKbps: null, uploadKbps: null },
  offline: { profile: 'offline', offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 },
  'slow-3g': { profile: 'slow-3g', offline: false, latencyMs: 400, downloadKbps: 400, uploadKbps: 400 },
  'fast-3g': { profile: 'fast-3g', offline: false, latencyMs: 150, downloadKbps: 1600, uploadKbps: 750 },
  lte: { profile: 'lte', offline: false, latencyMs: 40, downloadKbps: 12000, uploadKbps: 12000 },
});

function kbpsToBytesPerSecond(kbps) {
  const n = Number(kbps);
  return Number.isFinite(n) ? Math.round(n * 1000 / 8) : -1;
}

function throttleCdpParams(profile) {
  if (profile.profile === 'off') {
    return { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  }
  return {
    offline: profile.offline === true,
    latency: Number(profile.latencyMs || 0),
    downloadThroughput: profile.offline ? 0 : kbpsToBytesPerSecond(profile.downloadKbps),
    uploadThroughput: profile.offline ? 0 : kbpsToBytesPerSecond(profile.uploadKbps),
  };
}

function parseNonNegativeNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`throttle ${label} requires a non-negative number`);
  return n;
}

function parseThrottleArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args || [];
  if (tokens.length === 0) return { mode: 'status', format: fopts.format };
  let profileName = String(tokens[0] || '').toLowerCase();
  if (profileName === 'reset' || profileName === 'none') profileName = 'off';
  let profile;
  if (profileName === 'custom') {
    const custom = { profile: 'custom', offline: false, latencyMs: 0, downloadKbps: null, uploadKbps: null };
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '--latency') custom.latencyMs = parseNonNegativeNumber(tokens[++i], '--latency');
      else if (token === '--download' || token === '--down') custom.downloadKbps = parseNonNegativeNumber(tokens[++i], token);
      else if (token === '--upload' || token === '--up') custom.uploadKbps = parseNonNegativeNumber(tokens[++i], token);
      else throw new Error(`throttle custom: unknown option ${token}`);
    }
    if (custom.downloadKbps == null || custom.uploadKbps == null) {
      throw new Error('throttle custom requires --download <kbps> and --upload <kbps>');
    }
    profile = custom;
  } else {
    profile = THROTTLE_PRESETS[profileName];
    if (!profile) {
      throw new Error(`Unknown throttle profile: ${tokens[0]}. Use off, offline, slow-3g, fast-3g, lte, or custom.`);
    }
    if (tokens.length > 1) {
      throw new Error(`throttle ${tokens[0]} does not accept extra arguments. Use custom --latency <ms> --download <kbps> --upload <kbps>.`);
    }
    profile = { ...profile };
  }
  const cdpParams = throttleCdpParams(profile);
  return { mode: 'apply', format: fopts.format, ...profile, cdpParams };
}

function formatThrottleSummary(profile = null) {
  if (!profile || profile.profile === 'off') return 'off';
  if (profile.offline) return 'offline';
  return `${profile.profile} — latency ${profile.latencyMs}ms, ${profile.downloadKbps} kbps down, ${profile.uploadKbps} kbps up`;
}

function throttleModel(session, parsed) {
  const current = parsed.mode === 'status'
    ? (session.networkThrottle || { profile: 'off', offline: false, latencyMs: 0, downloadKbps: null, uploadKbps: null })
    : parsed;
  return {
    schema: 'chrome-cdp-ex.throttle.v1',
    targetId: session.targetId,
    mode: parsed.mode,
    profile: current.profile || 'off',
    offline: current.offline === true,
    latencyMs: current.latencyMs || 0,
    downloadKbps: current.downloadKbps,
    uploadKbps: current.uploadKbps,
    cdpParams: current.cdpParams || throttleCdpParams(current),
  };
}

function formatThrottleText(model) {
  const lines = [`Network throttle: ${formatThrottleSummary(model)}`];
  if (model.mode === 'status') {
    lines.push(`Next: cdp throttle ${model.targetId} slow-3g  # apply a preset`);
  } else if (model.profile === 'off') {
    lines.push('Network conditions reset to browser defaults.');
    lines.push(`Next: cdp throttle ${model.targetId} slow-3g  # re-apply a preset`);
  } else {
    lines.push(`Next: cdp throttle ${model.targetId} off`);
  }
  return lines.join('\n');
}

async function throttleStr(cdp, sid, session, args = []) {
  const parsed = parseThrottleArgs(args);
  if (parsed.mode === 'apply') {
    await cdp.send('Network.enable', {}, sid);
    await cdp.send('Network.emulateNetworkConditions', parsed.cdpParams, sid);
    session.networkThrottle = {
      profile: parsed.profile,
      offline: parsed.offline,
      latencyMs: parsed.latencyMs,
      downloadKbps: parsed.downloadKbps,
      uploadKbps: parsed.uploadKbps,
      cdpParams: parsed.cdpParams,
      appliedAt: Date.now(),
    };
    appendSessionEnvironmentLog(session, { kind: 'throttle', ts: session.networkThrottle.appliedAt, action: 'apply', throttle: session.networkThrottle });
  }
  const model = throttleModel(session, parsed);
  return parsed.format === 'json' ? formatJson(model) : formatThrottleText(model);
}

function clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq }) {
  consoleBuf?.clear();
  exceptionBuf?.clear();
  navBuf?.clear();
  netReqBuf?.clear();
  pendingReqs?.clear();
  if (lastReadSeq) {
    lastReadSeq.console = consoleBuf?.latest?.() || 0;
    lastReadSeq.exception = exceptionBuf?.latest?.() || 0;
  }
}

async function waitForActionNetworkQuiet(pendingReqs, { quietMs = 150, timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let quietSince = pendingReqs?.size ? 0 : Date.now();
  while (Date.now() < deadline) {
    if (pendingReqs?.size) {
      quietSince = 0;
    } else {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) return true;
    }
    await sleep(50);
  }
  return !pendingReqs?.size;
}

function appendPendingActionNetworkEntries(pendingReqs, netReqBuf, sinceTs, { now = Date.now() } = {}) {
  if (!pendingReqs || !netReqBuf) return 0;
  let count = 0;
  for (const req of pendingReqs.values()) {
    if (!req || req.actionEvidenceReported || req.ts < sinceTs) continue;
    req.actionEvidenceReported = true;
    netReqBuf.push({
      method: req.method,
      url: req.url,
      status: 'pending',
      type: req.type,
      duration: now - req.ts,
      size: 0,
      pending: true,
      ts: req.ts,
    });
    count += 1;
  }
  return count;
}

async function viewportStr(cdp, sid, size) {
  if (!size) {
    const dims = await evalStr(cdp, sid, `JSON.stringify({w:window.innerWidth,h:window.innerHeight,dpr:window.devicePixelRatio})`);
    const d = JSON.parse(dims);
    return `Viewport: ${d.w}×${d.h} (DPR: ${d.dpr})`;
  }
  const match = size.match(/^(\d+)[x×](\d+)$/);
  if (!match) throw new Error('Format: <width>x<height> (e.g. 375x812, 1280x720)');
  const width = parseInt(match[1]), height = parseInt(match[2]);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 0, mobile: width <= 768,
  }, sid);
  return `Viewport resized to ${width}×${height}${width <= 768 ? ' (mobile mode)' : ''}`;
}

async function cookieSetStr(cdp, sid, cookieStr) {
  if (!cookieStr) throw new Error('Cookie string required: "name=value" or "name=value; domain=.example.com"');
  const parts = cookieStr.split(';').map(s => s.trim());
  const [name, ...valParts] = parts[0].split('=');
  const value = valParts.join('='); // handle values with = in them
  if (!name) throw new Error('Cookie name required');

  const cookie = { name: name.trim(), value };
  for (const part of parts.slice(1)) {
    const [k, ...v] = part.split('=');
    const key = k.trim().toLowerCase();
    const val = v.join('=').trim();
    if (key === 'domain') cookie.domain = val;
    else if (key === 'path') cookie.path = val;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = val;
  }

  // Batch location queries into a single eval round-trip
  const loc = JSON.parse(await evalStr(cdp, sid, 'JSON.stringify({hostname:location.hostname,href:location.href})'));
  if (!cookie.domain) cookie.domain = loc.hostname;
  cookie.url = loc.href;

  const { success } = await cdp.send('Network.setCookie', cookie, sid);
  if (!success) throw new Error(`Failed to set cookie: ${name}`);
  return `Cookie set: ${name}=${value.substring(0, 30)}${value.length > 30 ? '...' : ''} (domain: ${cookie.domain})`;
}

async function cookieDelStr(cdp, sid, name) {
  if (!name) throw new Error('Cookie name required');
  const url = await evalStr(cdp, sid, 'window.location.href');
  await cdp.send('Network.deleteCookies', { name, url }, sid);
  return `Cookie deleted: ${name}`;
}

async function uploadStr(cdp, sid, selector, filePaths) {
  if (!selector) throw new Error('CSS selector for <input type="file"> required');
  if (!filePaths) throw new Error('File path(s) required (comma-separated for multiple)');
  const files = filePaths.split(',').map(f => f.trim());
  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sid);
  if (!nodeId) throw new Error('Element not found: ' + selector);
  // Validate it's a file input — attributes is a flat [name, value, name, value, ...] array
  const { node } = await cdp.send('DOM.describeNode', { nodeId }, sid);
  const attrs = node.attributes || [];
  const typeIdx = attrs.indexOf('type');
  if (node.nodeName !== 'INPUT' || typeIdx === -1 || attrs[typeIdx + 1] !== 'file')
    throw new Error('Element is not an <input type="file">');
  await cdp.send('DOM.setFileInputFiles', { files, nodeId }, sid);
  return `Uploaded ${files.length} file(s) to ${selector}: ${files.join(', ')}`;
}

// --- Clean text extraction ---
// Parse `text` arguments. Supports:
//   text                          → full body
//   text "main, [role=main]"      → fallback chain (try first, then next…)
//   text --auto                   → auto-pick main content (excludes nav/aside/script/style)
//   text --root auto|body|document|<sel>  → scope extraction root
//   text --auto --exclude "nav,.sidebar"  → custom extra exclusions
function parseTextArgs(args) {
  const opts = { selectors: [], auto: false, exclude: null, root: null };
  const tokens = Array.isArray(args) ? args.filter(a => a !== undefined && a !== null) : [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === '--auto') opts.auto = true;
    else if (a === '--root') opts.root = tokens[++i] || 'auto';
    else if (a === '--exclude' || a === '-x') opts.exclude = tokens[++i];
    else if (typeof a === 'string') {
      // Comma list = fallback chain (try each until one matches)
      const parts = a.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      opts.selectors.push(...parts);
    }
  }
  return opts;
}

function formatTextNoMatchError(parsed = {}, opts = {}) {
  const tried = (parsed.tried || []).join(', ') || '(no candidates)';
  const root = parsed.root || opts.root || 'auto';
  const selector = (opts.selectors && opts.selectors[0]) || parsed.sel || '';
  const lines = [
    `text: no element matched within root "${root}". Tried: ${tried}.`,
    `Scope: root=${root}${selector ? `; selector=${selector}` : ''}.`,
  ];
  if (selector) {
    lines.push(`Fallback: cdp eval <target> "document.querySelector(${JSON.stringify(selector)})?.textContent"`);
  } else {
    lines.push('Try `text <target> --auto` or `text <target> "main, [role=main], body"`.');
  }
  lines.push('Tip: `text --root body|document|auto|<css>` changes the search root.');
  return lines.join(' ');
}

function textPageScript(opts) {
  const { selectors = [], auto = false, exclude = null, root = null } = opts || {};
  const extraExcludes = exclude ? exclude.split(',').map(s => s.trim()).filter(Boolean) : [];
  // Explicit selectors default to document-wide search so they match eval's
  // document.querySelector behavior. Full-page / --auto extraction still uses
  // auto root candidates to reduce nav/shell noise.
  const defaultRoot = (selectors.length > 0 && !auto) ? 'document' : 'auto';
  return `(function() {
    const STRIP = ['script','style','noscript','svg','link','meta','template'];
    const AUTO_NOISE = ['nav','aside','footer','[role="navigation"]','[role="complementary"]','[role="contentinfo"]'];
    const ROOT_CANDIDATES = ['#root', '[data-reactroot]', 'main', 'body'];
    const AUTO_CANDIDATES = ['main', '[role="main"]', 'article', '#root main', '#app main', '#root', '[data-reactroot]', '#app', 'body'];
    const EXTRA_EXCLUDES = ${JSON.stringify(extraExcludes)};
    function safeMatches(el, sel) { try { return !!el?.matches?.(sel); } catch { return false; } }
    function safeQuery(root, sel) { try { return root?.querySelector?.(sel) || null; } catch { return null; } }
    function selectorFallbacks(sel) {
      const s = String(sel || '').trim();
      if (s.toLowerCase() === 'header') {
        return ['header', '[role="banner"]', '[data-testid*="header" i]', '[class*="header" i]', '[id*="header" i]', 'h1', 'h2'];
      }
      return [s];
    }
    function pickRoot() {
      const setting = ${JSON.stringify(root || defaultRoot)};
      if (!setting || setting === 'auto' || setting === 'default') {
        for (const sel of ROOT_CANDIDATES) {
          const found = safeQuery(document, sel);
          if (found) return { el: found, sel };
        }
        return { el: document.body || document.documentElement, sel: 'body' };
      }
      if (setting === 'document') {
        return { el: document.documentElement || document.body, sel: 'document' };
      }
      if (setting === 'body') {
        return { el: document.body || document.documentElement, sel: 'body' };
      }
      const found = safeQuery(document, setting);
      return found ? { el: found, sel: setting } : { el: null, sel: setting };
    }
    function shouldSkipElement(el, rootEl, skipSelectors) {
      if (!el || el === rootEl) return false;
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
      for (const sel of skipSelectors) if (safeMatches(el, sel)) return true;
      const style = window.getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
    }
    function clean(rootEl, stripNoise) {
      if (!rootEl) return '';
      const skipSelectors = STRIP.concat(EXTRA_EXCLUDES, stripNoise ? AUTO_NOISE : []);
      const parts = [];
      const blockish = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BR','DIV','DL','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TR','UL']);
      function walk(node) {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          parts.push(node.nodeValue || '');
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return;
        const el = node.nodeType === Node.ELEMENT_NODE ? node : null;
        if (el && shouldSkipElement(el, rootEl, skipSelectors)) return;
        if (el?.tagName === 'BR') { parts.push('\\n'); return; }
        for (const child of node.childNodes) walk(child);
        if (el && blockish.has(el.tagName)) parts.push('\\n');
      }
      walk(rootEl);
      return parts.join('')
        .replace(/[ \\t\\f\\v]+/g, ' ')
        .replace(/ *\\n */g, '\\n')
        .replace(/(\\n\\s*){3,}/g, '\\n\\n')
        .trim();
    }
    function findWithin(scope, sel, tried) {
      for (const candidate of selectorFallbacks(sel)) {
        tried.push(candidate);
        if (safeMatches(scope, candidate)) return { el: scope, sel: candidate };
        const found = safeQuery(scope, candidate);
        if (found) return { el: found, sel: candidate === sel ? candidate : candidate + ' (fallback for ' + sel + ')' };
      }
      return null;
    }
    const tried = [];
    const rootInfo = pickRoot();
    if (!rootInfo.el) return JSON.stringify({ ok: false, root: rootInfo.sel, tried: ['--root ' + rootInfo.sel] });
    const scope = rootInfo.el;
    const selectors = ${JSON.stringify(selectors)};
    for (const sel of selectors) {
      const found = findWithin(scope, sel, tried);
      if (found) return JSON.stringify({ ok: true, sel: found.sel, root: rootInfo.sel, text: clean(found.el, false) });
    }
    if (${auto ? 'true' : 'false'}) {
      for (const sel of AUTO_CANDIDATES) {
        const found = findWithin(scope, sel, tried);
        if (!found) continue;
        const text = clean(found.el, true);
        if (text.length > 0) return JSON.stringify({ ok: true, sel: found.sel + ' (auto)', root: rootInfo.sel, text });
        tried.push(sel + ' (auto)');
      }
    }
    if (selectors.length === 0 && !${auto ? 'true' : 'false'}) {
      return JSON.stringify({ ok: true, sel: rootInfo.sel, root: rootInfo.sel, text: clean(scope, false) });
    }
    return JSON.stringify({ ok: false, root: rootInfo.sel, tried });
  })()`;
}

async function textStr(cdp, sid, args) {
  // Support legacy single-string call: textStr(cdp, sid, 'main') — wrap into args[]
  let optsArgs = args;
  if (typeof args === 'string' || args == null) optsArgs = args ? [args] : [];
  else if (!Array.isArray(args)) optsArgs = [];
  const opts = parseTextArgs(optsArgs);
  const result = await evalStr(cdp, sid, textPageScript(opts));
  let parsed;
  try { parsed = JSON.parse(result); }
  catch { return result; }
  if (!parsed.ok) {
    throw new Error(formatTextNoMatchError(parsed, opts));
  }
  const out = parsed.text || '';
  // Hint when no scope was given and text is large.
  const noScope = opts.selectors.length === 0 && !opts.auto;
  if (noScope && out.length > 2000) {
    return out + '\n\n(Hint: output is large — use `text <target> --auto` or `text <target> "main"` / `text <target> "main, [role=main], #app .main"` to scope to a specific area)';
  }
  return out;
}

// --- Full table data extraction ---
async function tableStr(cdp, sid, selector) {
  const sel = selector || 'table';
  return evalStr(cdp, sid, `(function() {
    const tables = document.querySelectorAll(${JSON.stringify(sel)});
    if (tables.length === 0) return 'No tables found' + (${JSON.stringify(sel)} !== 'table' ? ' matching ' + ${JSON.stringify(sel)} : '');
    const results = [];
    for (let ti = 0; ti < tables.length && ti < 10; ti++) {
      const tbl = tables[ti];
      const caption = tbl.querySelector('caption')?.textContent?.trim() || tbl.getAttribute('aria-label') || 'Table ' + (ti + 1);
      const rows = [];
      for (const tr of tbl.querySelectorAll('tr')) {
        const cells = [];
        for (const cell of tr.querySelectorAll('th, td')) {
          cells.push(cell.textContent.trim().replace(/\\s+/g, ' '));
        }
        if (cells.length > 0) rows.push(cells.join('\\t'));
      }
      results.push(caption + ':\\n' + rows.join('\\n'));
    }
    return results.join('\\n\\n');
  })()`);
}

// --- Navigation history ---
async function historyNavStr(cdp, sid, direction) {
  const { currentIndex, entries } = await cdp.send('Page.getNavigationHistory', {}, sid);
  const targetIdx = currentIndex + direction;
  if (targetIdx < 0) throw new Error('No previous page in history');
  if (targetIdx >= entries.length) throw new Error('No forward page in history');
  await cdp.send('Page.navigateToHistoryEntry', { entryId: entries[targetIdx].id }, sid);
  await sleep(500);
  const url = await evalStr(cdp, sid, 'window.location.href');
  return `Navigated ${direction < 0 ? 'back' : 'forward'} to: ${url}`;
}

async function reloadStr(cdp, sid) {
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', RELOAD_EVENT_TIMEOUT);
  try {
    await cdp.send('Page.reload', {}, sid, RELOAD_DISPATCH_TIMEOUT);
  } catch (e) {
    if (!isTimeoutError(e, ['Page.reload'])) throw e;
  }
  try {
    await Promise.race([
      loadEvent.promise,
      waitForDocumentReady(cdp, sid, RELOAD_READY_TIMEOUT, { probeTimeoutMs: RELOAD_READY_PROBE_TIMEOUT }),
    ]);
  } catch {
    // Some embedded/live targets do not reliably emit Page.loadEventFired after
    // reload. Action feedback still performs a bounded post-reload observation.
  } finally {
    loadEvent.cancel?.();
  }
  return 'Page reloaded';
}

async function observeReloadPage(cdp, sid) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title || '',
      url: window.location.href || '',
      readyState: document.readyState || ''
    })`,
    returnByValue: true,
    awaitPromise: true,
  }, sid, RELOAD_OBSERVE_TIMEOUT);
  if (result.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  }
  const value = result.result?.value;
  const parsed = typeof value === 'string' ? JSON.parse(value) : (value || {});
  return [
    'Reload observation:',
    `Page: ${parsed.title || '(untitled)'}`,
    `URL: ${parsed.url || '(unknown)'}`,
    `Ready state: ${parsed.readyState || '(unknown)'}`,
  ].join('\n');
}

async function reloadActionDispatch({ cdp, sessionId, session, consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq }) {
  const reloadResult = await reloadStr(cdp, sessionId);
  clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq });
  invalidateSessionRefs(session, 'navigation');
  return `${reloadResult} (console/exception/navigation buffers cleared)`;
}

// --- Inject: live CSS/JS injection with tracking ---
async function injectStr(cdp, sid, args) {
  const type = args[0];
  const content = args.slice(1).join(' ');

  if (type === '--remove') {
    const selector = content
      ? `[data-cdp-inject="${content}"]`
      : '[data-cdp-inject]';
    return evalStr(cdp, sid, `(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      els.forEach(el => el.remove());
      return els.length + ' element(s) removed';
    })()`);
  }

  if (type === '--css') {
    if (!content) throw new Error('CSS text required: inject --css "body { background: red }"');
    return evalStr(cdp, sid, `(() => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const s = document.createElement('style');
      s.setAttribute('data-cdp-inject', id);
      s.textContent = ${JSON.stringify(content)};
      document.head.appendChild(s);
      return id;
    })()`);
  }

  if (type === '--css-file') {
    if (!content) throw new Error('URL required: inject --css-file https://example.com/style.css');
    validateUrl(content);
    return evalStr(cdp, sid, `new Promise((resolve, reject) => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = ${JSON.stringify(content)};
      link.setAttribute('data-cdp-inject', id);
      link.onload = () => resolve(id);
      link.onerror = () => reject(new Error('Failed to load stylesheet: ' + ${JSON.stringify(content)}));
      document.head.appendChild(link);
    })`);
  }

  if (type === '--js-file') {
    if (!content) throw new Error('URL required: inject --js-file https://example.com/lib.js');
    validateUrl(content);
    return evalStr(cdp, sid, `new Promise((resolve, reject) => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const s = document.createElement('script');
      s.src = ${JSON.stringify(content)};
      s.setAttribute('data-cdp-inject', id);
      s.onload = () => resolve(id);
      s.onerror = () => reject(new Error('Failed to load script: ' + ${JSON.stringify(content)}));
      document.head.appendChild(s);
    })`);
  }

  throw new Error('inject requires --css, --css-file, --js-file, or --remove\n  inject --css "body { color: red }"   inject inline CSS\n  inject --css-file <url>              load external stylesheet\n  inject --js-file <url>               load external script\n  inject --remove [id]                 remove injected element(s)');
}

// --- Record: short timeline capture around actions / waits ---
function formatRecordEvent(e, startTs) {
  const rel = Math.max(0, e.ts - startTs).toString().padStart(5, ' ');
  if (e.kind === 'dom') return `  +${rel}ms DOM ${e.summary}`;
  if (e.kind === 'console') return `  +${rel}ms console.${e.level}: ${e.text}${e.loc ? ' (' + e.loc + ')' : ''}`;
  if (e.kind === 'exception') return `  +${rel}ms exception: ${e.msg}${e.loc ? ' (' + e.loc + ')' : ''}`;
  if (e.kind === 'network') return `  +${rel}ms ${e.method} ${e.url} → ${e.status} (${e.duration}ms)`;
  if (e.kind === 'navigation') return `  +${rel}ms navigation ${e.url}`;
  if (e.kind === 'action') return `  +${rel}ms action ${e.summary}`;
  return `  +${rel}ms ${e.kind || 'event'} ${e.summary || ''}`.trimEnd();
}

function parseRecordArgs(args) {
  const opts = { durationMs: 1000, until: null, action: null, actionArgs: [], explicitDuration: false };
  const setUntil = (val) => {
    const v = (val || '').toLowerCase();
    if (!['dom stable', 'network idle', 'auto settle'].includes(v)) throw new Error('record --until supports "dom stable" or "network idle"');
    opts.until = v;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--action') {
      opts.action = args[++i];
      if (!opts.action) throw new Error('record --action requires an action command (click, press, fill, select, type, scroll, nav)');
      const rest = args.slice(i + 1);
      const actionArgs = [];
      for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        if (a === '--until') { setUntil(rest[++j]); continue; }
        if (/^\d+$/.test(a) && j === rest.length - 1) {
          opts.durationMs = Math.min(Math.max(parseInt(a), 100), 30000);
          opts.explicitDuration = true;
          continue;
        }
        actionArgs.push(a);
      }
      opts.actionArgs = actionArgs;
      break;
    }
    if (arg === '--until') { setUntil(args[++i]); continue; }
    if (/^\d+$/.test(arg)) {
      opts.durationMs = Math.min(Math.max(parseInt(arg), 100), 30000);
      opts.explicitDuration = true;
      continue;
    }
    throw new Error(`Unknown record argument: ${arg}`);
  }
  // --action with no explicit duration and no --until: auto-settle (DOM/network quiet)
  // Cap: 5s for DOM-only, 10s if network activity observed.
  if (opts.action && !opts.until && !opts.explicitDuration) {
    opts.until = 'auto settle';
    opts.durationMs = 10000;
  } else if (opts.until && !opts.explicitDuration) {
    opts.durationMs = 30000;
  }
  return opts;
}

async function collectDomMutationSummary(cdp, sid) {
  const raw = await evalStr(cdp, sid, `(function() {
    const bucket = window.__cdp_record_mutations || [];
    window.__cdp_record_mutations = [];
    const totals = { added: 0, removed: 0, attributes: 0, characterData: 0 };
    const labels = [];
    for (const m of bucket) {
      if (m.type === 'childList') { totals.added += m.added || 0; totals.removed += m.removed || 0; }
      else if (m.type === 'attributes') totals.attributes += 1;
      else if (m.type === 'characterData') totals.characterData += 1;
      if (m.label && labels.length < 4) labels.push(m.label);
    }
    return JSON.stringify({ totals, labels, count: bucket.length });
  })()`);
  const parsed = JSON.parse(raw || '{}');
  if (!parsed.count) return null;
  const parts = [];
  if (parsed.totals.added) parts.push(`${parsed.totals.added} added`);
  if (parsed.totals.removed) parts.push(`${parsed.totals.removed} removed`);
  if (parsed.totals.attributes) parts.push(`${parsed.totals.attributes} attr`);
  if (parsed.totals.characterData) parts.push(`${parsed.totals.characterData} text`);
  const labelText = parsed.labels?.length ? ` [${parsed.labels.join('; ')}]` : '';
  return `${parts.join(', ') || parsed.count + ' mutation(s)'}${labelText}`;
}

async function installRecordMutationObserver(cdp, sid) {
  await evalStr(cdp, sid, `(function() {
    if (window.__cdp_record_observer) { window.__cdp_record_mutations = []; return 'already'; }
    window.__cdp_record_mutations = [];
    const label = (node) => {
      if (!node || node.nodeType !== 1) return '';
      const el = node;
      const id = el.id ? '#' + el.id : '';
      const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '';
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
      return '<' + el.tagName.toLowerCase() + id + cls + '>' + (text ? ' "' + text + '"' : '');
    };
    window.__cdp_record_observer = new MutationObserver((mutations) => {
      const out = window.__cdp_record_mutations || (window.__cdp_record_mutations = []);
      for (const m of mutations) {
        out.push({
          type: m.type,
          added: m.addedNodes ? m.addedNodes.length : 0,
          removed: m.removedNodes ? m.removedNodes.length : 0,
          attr: m.attributeName || '',
          label: label(m.target) || label(m.addedNodes && m.addedNodes[0]) || label(m.removedNodes && m.removedNodes[0]),
        });
      }
      if (out.length > 200) out.splice(0, out.length - 200);
    });
    window.__cdp_record_observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
    return 'installed';
  })()`);
}

async function recordStr(cdp, sid, args, refs) {
  const opts = parseRecordArgs(args);
  const startTs = Date.now();
  const events = [];
  const offConsole = cdp.onEvent?.('Runtime.consoleAPICalled', (params) => {
    const text = (params.args || []).map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
    events.push({ kind: 'console', level: params.type || 'log', text, ts: Date.now() });
  });
  const offException = cdp.onEvent?.('Runtime.exceptionThrown', (params) => {
    events.push({ kind: 'exception', msg: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'Unknown error', ts: Date.now() });
  });
  const pending = new Map();
  const offReq = cdp.onEvent?.('Network.requestWillBeSent', (params) => {
    if (['XHR','Fetch','Document'].includes(params.type)) pending.set(params.requestId, { method: params.request.method, url: params.request.url.substring(0, 160), ts: Date.now() });
  });
  const offRes = cdp.onEvent?.('Network.responseReceived', (params) => {
    const req = pending.get(params.requestId);
    if (!req) return;
    pending.delete(params.requestId);
    events.push({ kind: 'network', ...req, status: params.response.status, duration: Date.now() - req.ts, ts: Date.now() });
  });
  const offNav = cdp.onEvent?.('Page.frameNavigated', (params) => {
    if (!params.frame?.parentId) events.push({ kind: 'navigation', url: params.frame?.url || '', ts: Date.now() });
  });

  // Wrap setup/action/loop in try/finally so the temporary listeners are
  // always detached — including when an action throws (unsupported action,
  // click/fill failure, CDP error). Leaking listeners would pollute future
  // record/timeline runs on the same daemon.
  try {
    try { await cdp.send('Runtime.enable', {}, sid); } catch {}
    try { await cdp.send('Page.enable', {}, sid); } catch {}
    try { await cdp.send('DOM.enable', {}, sid); } catch {}
    try { await cdp.send('Network.enable', {}, sid); } catch {}
    await installRecordMutationObserver(cdp, sid);

    let actionText = null;
    if (opts.action) {
      if (opts.action === 'click') actionText = await clickStr(cdp, sid, opts.actionArgs[0], refs);
      else if (opts.action === 'press') actionText = await pressStr(cdp, sid, opts.actionArgs[0]);
      else if (opts.action === 'fill') actionText = await fillStr(cdp, sid, opts.actionArgs[0], opts.actionArgs.slice(1).join(' '), refs);
      else if (opts.action === 'select') actionText = await selectStr(cdp, sid, opts.actionArgs[0], opts.actionArgs[1]);
      else if (opts.action === 'type') actionText = await typeStr(cdp, sid, opts.actionArgs.join(' '));
      else if (opts.action === 'scroll') actionText = await scrollStr(cdp, sid, opts.actionArgs[0], opts.actionArgs[1]);
      else if (opts.action === 'nav' || opts.action === 'navigate') actionText = await navStr(cdp, sid, opts.actionArgs[0]);
      else throw new Error(`record --action does not support: ${opts.action}`);
      events.push({ kind: 'action', summary: actionText.split('\n')[0], ts: Date.now() });
    }

    let quietSince = Date.now();
    let networkSeen = false;
    const deadline = Date.now() + opts.durationMs;
    // Auto-settle cap: 5s if no network activity has been observed yet, else 10s.
    const autoCap = () => Date.now() - startTs >= (networkSeen ? 10000 : 5000);
    while (Date.now() < deadline) {
      await sleep(Math.min(100, deadline - Date.now()));
      const domSummary = await collectDomMutationSummary(cdp, sid);
      if (domSummary) { events.push({ kind: 'dom', summary: domSummary, ts: Date.now() }); quietSince = Date.now(); }
      if (pending.size > 0 || events.some(e => e.kind === 'network')) networkSeen = true;
      if (opts.until === 'network idle' && pending.size === 0 && Date.now() - quietSince >= 500) break;
      if (opts.until === 'dom stable' && Date.now() - quietSince >= 500) break;
      if (opts.until === 'auto settle' && pending.size === 0 && Date.now() - quietSince >= 500) break;
      if (opts.until === 'auto settle' && autoCap()) break;
      if (!opts.until && Date.now() >= deadline) break;
    }

    const lines = [`Record timeline (${Date.now() - startTs}ms${opts.action ? `, action: ${opts.action}` : ''}${opts.until ? `, until: ${opts.until}` : ''})`];
    if (actionText) lines.push(`Action: ${actionText.split('\n')[0]}`);
    if (events.length === 0) lines.push('  (no DOM, console, exception, navigation, or XHR/Fetch/Document network events observed)');
    else for (const e of events.sort((a,b) => a.ts - b.ts)) lines.push(formatRecordEvent(e, startTs));
    return lines.join('\n');
  } finally {
    offConsole?.();
    offException?.();
    offReq?.();
    offRes?.();
    offNav?.();
  }
}

// --- Cascade: CSS origin tracing via CSS.getMatchedStylesForNode ---
const INHERITABLE_PROPS = new Set([
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-indent',
  'text-transform', 'white-space', 'word-spacing', 'visibility',
  'cursor', 'direction', 'list-style',
]);

// Strip Vite/CSS Module query suffixes (?vue&type=style&lang.css, ?direct, ?used)
function stripVitePathQuery(url) {
  if (!url) return url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

const _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeVLQ(str) {
  const out = [];
  let value = 0, shift = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = _B64.indexOf(str[i]);
    if (ch === -1) return out;
    const cont = ch & 32;
    const digit = ch & 31;
    value += digit << shift;
    shift += 5;
    if (!cont) {
      const negate = value & 1;
      out.push(negate ? -(value >> 1) : (value >> 1));
      value = 0; shift = 0;
    }
  }
  return out;
}

// Walk source-map mappings to find first segment on generated line `genLine0`
function mapLineToSource(mappings, genLine0) {
  if (typeof mappings !== 'string' || !mappings) return null;
  const lines = mappings.split(';');
  if (genLine0 < 0 || genLine0 >= lines.length) return null;
  let srcIdx = 0, origLine = 0, origCol = 0;
  let result = null;
  for (let i = 0; i <= genLine0; i++) {
    const segments = lines[i].split(',');
    for (const seg of segments) {
      if (!seg) continue;
      const vals = decodeVLQ(seg);
      if (vals.length >= 4) {
        srcIdx += vals[1];
        origLine += vals[2];
        origCol += vals[3];
        if (i === genLine0 && result === null) {
          result = { srcIdx, origLine, origCol };
        }
      }
    }
  }
  return result;
}

function mapInlineSourceMap(sheetText, genLine0) {
  const m = sheetText.match(/sourceMappingURL=data:application\/json[^,]*?base64,([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  let json;
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    json = JSON.parse(decoded);
  } catch { return null; }
  const sources = json.sources || [];
  if (sources.length === 0) return null;
  const mapping = mapLineToSource(json.mappings || '', genLine0);
  const srcIdx = mapping ? Math.max(0, Math.min(mapping.srcIdx, sources.length - 1)) : 0;
  const origLine = mapping ? mapping.origLine : genLine0;
  const sourceRoot = (json.sourceRoot || '').replace(/\/$/, '');
  const rawSrc = sources[srcIdx] || '';
  if (!rawSrc) return null;
  const fullPath = sourceRoot ? `${sourceRoot}/${rawSrc}` : rawSrc;
  return `${stripVitePathQuery(fullPath)}:${origLine + 1}`;
}

// Map a stylesheet line to the most-informative source location available
function mapStyleSource(sheetText, sheetId, genLine0) {
  const text = sheetText || '';
  const inline = mapInlineSourceMap(text, genLine0);
  if (inline) return inline;
  const sourceUrl = text.match(/\/\*#?\s*sourceURL=([^*\n]+)\s*\*\//)?.[1]
    || text.match(/\/\/# sourceURL=([^\n]+)/)?.[1];
  if (sourceUrl) return `${stripVitePathQuery(sourceUrl.trim())}:${genLine0 + 1}`;
  const mapUrl = text.match(/sourceMappingURL=([^\s*]+)/)?.[1];
  if (mapUrl && !mapUrl.startsWith('data:')) {
    return `${stripVitePathQuery(mapUrl.trim().replace(/\.map$/, ''))}:${genLine0 + 1}`;
  }
  return `${sheetId}:${genLine0 + 1}`;
}

async function resolveStyleSource(cdp, sid, rule) {
  const origin = rule.origin;
  if (origin === 'user-agent') return 'user-agent stylesheet';
  const sheetId = rule.style?.styleSheetId;
  if (!sheetId) return origin === 'regular' ? 'inline style' : (origin || 'unknown stylesheet');
  const range = rule.style.range;
  const genLine0 = range ? range.startLine : 0;
  let header;
  try { header = await cdp.send('CSS.getStyleSheetText', { styleSheetId: sheetId }, sid); } catch {}
  return mapStyleSource(header?.text || '', sheetId, genLine0);
}

async function cascadeStr(cdp, sid, selector, property, refMap, refState, opts = {}) {
  if (!selector) throw new Error('CSS selector or @ref required');

  // CSS.getMatchedStylesForNode requires these domains/document state. Enable
  // them inside cascade so the first call works even before evalraw/perceive.
  try { await cdp.send('DOM.enable', {}, sid); } catch {}
  try { await cdp.send('CSS.enable', {}, sid); } catch {}
  const { root } = await cdp.send('DOM.getDocument', {}, sid);

  // Resolve element to DOM nodeId
  let nodeId;
  if (isRef(selector)) {
    const frameParsed = parseFrameRef(selector);
    let backendNodeId;
    if (frameParsed) {
      backendNodeId = frameScopedBackendNode(refState || {}, frameParsed).backendNodeId;
    } else {
      const num = parseInt(selector.slice(1));
      backendNodeId = refMap.get(num);
      if (!backendNodeId) throw new Error(formatUnknownRefError(selector, refState || {}));
    }
    const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend',
      { backendNodeIds: [backendNodeId] }, sid);
    nodeId = nodeIds[0];
  } else {
    const result = await cdp.send('DOM.querySelector',
      { nodeId: root.nodeId, selector }, sid);
    if (!result.nodeId) throw new Error('Element not found: ' + selector);
    nodeId = result.nodeId;
  }

  // Get matched styles + computed style in parallel
  const [matched, computed] = await Promise.all([
    cdp.send('CSS.getMatchedStylesForNode', { nodeId }, sid),
    cdp.send('CSS.getComputedStyleForNode', { nodeId }, sid),
  ]);

  // Build computed value lookup
  const computedMap = new Map();
  for (const c of computed.computedStyle || []) {
    computedMap.set(c.name, c.value);
  }

  // Collect rules by property
  const propRules = new Map();
  for (const match of matched.matchedCSSRules || []) {
    const rule = match.rule;
    const selectorText = rule.selectorList?.text || '?';
    const origin = rule.origin; // 'regular', 'user-agent', 'injected', 'inspector'
    const source = await resolveStyleSource(cdp, sid, rule);

    for (const prop of rule.style?.cssProperties || []) {
      if (prop.disabled || !prop.value) continue;
      if (prop.name.startsWith('-webkit-') || prop.name.startsWith('-moz-')) continue;
      if (property && prop.name !== property) continue;
      if (!propRules.has(prop.name)) propRules.set(prop.name, []);
      propRules.get(prop.name).push({
        value: prop.value,
        selector: selectorText,
        source,
        origin,
      });
    }
  }

  // Inline styles (highest specificity — style="" attribute)
  for (const prop of matched.inlineStyle?.cssProperties || []) {
    if (prop.disabled || !prop.value) continue;
    if (prop.name.startsWith('-webkit-') || prop.name.startsWith('-moz-')) continue;
    if (property && prop.name !== property) continue;
    if (!propRules.has(prop.name)) propRules.set(prop.name, []);
    // Insert at the beginning — inline styles win over everything
    propRules.get(prop.name).unshift({
      value: prop.value,
      selector: '[inline]',
      source: 'inline style attribute',
      origin: 'inline',
    });
  }

  const normalizeCssValue = (v) => String(v || '')
    .trim()
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ');

  // Dedupe identical (selector, normalized value, source, origin) entries per property.
  // CDP can return repeated matchedCSSRules / cssProperties (e.g. same rule
  // matched via multiple selectors in the selectorList, or authored vs normalized
  // values like rgb(37,99,235) vs rgb(37, 99, 235)); rendering them twice
  // misleadingly implies multiple independent winning rules.
  for (const [name, rules] of propRules) {
    const seen = new Set();
    const deduped = [];
    for (const r of rules) {
      const key = `${r.selector}\u0000${normalizeCssValue(r.value)}\u0000${r.source}\u0000${r.origin}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }
    propRules.set(name, deduped);
  }

  const hasInherited = (matched.inherited || []).some(inh =>
    inh.matchedCSSRules?.some(m =>
      m.rule.style?.cssProperties?.some(p => !p.disabled && p.value && INHERITABLE_PROPS.has(p.name))));

  if (propRules.size === 0 && !hasInherited && !property) {
    if (opts.format === 'json') {
      return formatJson({
        schema: 'chrome-cdp-ex.cascade.v1',
        input: { selector, property: null },
        propertyCount: 0,
        properties: [],
        inherited: [],
        editTarget: null,
        message: 'No matching CSS rules found for this element',
      });
    }
    return 'No matching CSS rules found for this element';
  }
  if (propRules.size === 0 && !hasInherited && property) {
    const computed = computedMap.get(property);
    if (opts.format === 'json') {
      return formatJson({
        schema: 'chrome-cdp-ex.cascade.v1',
        input: { selector, property },
        propertyCount: computed ? 1 : 0,
        properties: computed ? [{
          name: property,
          computedValue: computed,
          winner: null,
          rules: [],
          note: 'computed, no explicit rule found',
        }] : [],
        inherited: [],
        editTarget: null,
        message: computed
          ? `${property}: ${computed} (computed, no explicit rule found)`
          : `Property "${property}" not found on this element`,
      });
    }
    return computed
      ? `${property}: ${computed} (computed, no explicit rule found)`
      : `Property "${property}" not found on this element`;
  }

  // Format output
  const lines = [];
  const properties = [];
  for (const [prop, rules] of propRules) {
    const computedVal = computedMap.get(prop);
    if (!computedVal) continue;

    lines.push(`${prop}: ${computedVal}`);
    const ruleModels = [];
    let winner = null;
    for (const r of rules) {
      const isWinner = normalizeCssValue(r.value) === normalizeCssValue(computedVal);
      const mark = isWinner ? '✓' : '✗';
      const note = isWinner ? '' : '  [overridden]';
      const ruleModel = {
        selector: r.selector,
        value: r.value,
        source: r.source,
        origin: r.origin || null,
        winner: isWinner,
        overridden: !isWinner,
      };
      ruleModels.push(ruleModel);
      if (isWinner && !winner) winner = {
        selector: r.selector,
        value: r.value,
        source: r.source,
        origin: r.origin || null,
      };
      lines.push(`  ${mark} ${r.selector} { ${prop}: ${r.value} }${note}`);
      lines.push(`    → ${r.source}`);
    }
    properties.push({
      name: prop,
      computedValue: computedVal,
      winner,
      rules: ruleModels,
    });
    lines.push('');
  }

  // Inherited properties
  const inherited = matched.inherited || [];
  const inheritedLines = [];
  const inheritedModels = [];
  for (const inh of inherited) {
    for (const match of inh.matchedCSSRules || []) {
      const rule = match.rule;
      for (const prop of rule.style?.cssProperties || []) {
        if (prop.disabled || !prop.value) continue;
        if (!INHERITABLE_PROPS.has(prop.name)) continue;
        if (property && prop.name !== property) continue;
        const selectorText = rule.selectorList?.text || '?';
        const source = await resolveStyleSource(cdp, sid, rule);
        inheritedLines.push(`  ${prop.name}: ${prop.value}  ← ${selectorText}  → ${source}`);
        inheritedModels.push({
          name: prop.name,
          value: prop.value,
          selector: selectorText,
          source,
          origin: rule.origin || null,
        });
      }
    }
  }
  if (inheritedLines.length > 0) {
    lines.push('Inherited:');
    // Deduplicate identical lines (CDP can repeat the same inherited rule
    // across multiple ancestors / selectors); distinct (selector, source)
    // entries with the same property+value are still preserved.
    const seen = new Set();
    for (const l of inheritedLines) {
      if (seen.has(l)) continue;
      seen.add(l);
      lines.push(l);
    }
  }

  if (opts.format === 'json') {
    const editProperty = property
      ? properties.find(entry => entry.name === property)
      : properties.find(entry => entry.winner);
    const editTarget = editProperty?.winner
      ? {
        property: editProperty.name,
        selector: editProperty.winner.selector,
        value: editProperty.winner.value,
        source: editProperty.winner.source,
        origin: editProperty.winner.origin || null,
      }
      : null;
    return formatJson({
      schema: 'chrome-cdp-ex.cascade.v1',
      input: { selector, property: property || null },
      propertyCount: properties.length,
      properties,
      inherited: inheritedModels,
      editTarget,
      recommendation: editTarget
        ? {
          source: 'cascade',
          strategy: 'edit-winning-source',
          property: editTarget.property,
          selector: editTarget.selector,
          sourceLocation: editTarget.source,
        }
        : {
          source: 'cascade',
          strategy: 'inspect-computed-style',
        },
    });
  }

  return lines.join('\n').trim() || 'No matching CSS rules found';
}

// --- Tab close ---
async function closetabStr(cdp, targetId) {
  await cdp.send('Target.closeTarget', { targetId });
  return `Closed tab: ${targetId.slice(0, 8)}`;
}

// --- Batch result formatting ---
function firstNonEmptyLine(value, limit = 240) {
  const line = String(value ?? '').split('\n').map(s => s.trim()).find(Boolean) || '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function maybeParseJson(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function extractLabeledLine(text, label) {
  const re = new RegExp(`^${label}:\\s*(.+)$`, 'm');
  return String(text || '').match(re)?.[1]?.trim() || null;
}

function compactActionDiagnosisModel(diagnosis = null) {
  if (!diagnosis || typeof diagnosis !== 'object') return null;
  return {
    schema: diagnosis.schema || 'chrome-cdp-ex.action-diagnosis.v1',
    status: diagnosis.status || 'ok',
    kind: diagnosis.kind || 'ok',
    confidence: diagnosis.confidence || 'medium',
    source: diagnosis.source || 'action',
    reason: diagnosis.reason || '',
    nextCommand: diagnosis.nextCommand || null,
    recovery: diagnosis.recovery || null,
    signals: diagnosis.signals || {},
  };
}

function compactActionVerdictModel(verdict = null) {
  if (!verdict || typeof verdict !== 'object') return null;
  const nextSteps = Array.isArray(verdict.nextSteps) ? verdict.nextSteps.filter(Boolean) : [];
  return {
    schema: verdict.schema || 'chrome-cdp-ex.action-verdict.v1',
    status: verdict.status || 'verify',
    source: verdict.source || 'outcome',
    confidence: verdict.confidence || 'medium',
    canContinue: verdict.canContinue === true,
    needsRecovery: verdict.needsRecovery === true,
    primaryNextStep: verdict.primaryNextStep || null,
    nextSteps,
    reason: verdict.reason || null,
  };
}

function diagnosisFromActionModel(actionModel = null) {
  if (actionModel?.schema !== 'chrome-cdp-ex.action.v1') return null;
  return compactActionDiagnosisModel(actionModel.effects?.diagnosis || null);
}

function verdictFromActionModel(actionModel = null) {
  if (actionModel?.schema !== 'chrome-cdp-ex.action.v1') return null;
  return compactActionVerdictModel(actionModel.verdict || null);
}

function isAttentionDiagnosis(diagnosis = null) {
  return diagnosis?.status === 'attention';
}

function isAttentionVerdict(verdict = null) {
  if (!verdict || typeof verdict !== 'object') return false;
  if (verdict.needsRecovery === true) return true;
  return ['investigate', 'recover', 'blocked'].includes(verdict.status);
}

function recoveryCommandsFromVerdict(verdict = null) {
  const commands = Array.isArray(verdict?.nextSteps) ? verdict.nextSteps.filter(Boolean) : [];
  if (commands.length) return commands;
  return verdict?.primaryNextStep ? [verdict.primaryNextStep] : [];
}

function commandMeta(cmd) {
  return COMMANDS.find(command => command.name === cmd || (command.aliases || []).includes(cmd)) || null;
}

const BATCH_PARALLEL_READ_STATE_COMMANDS = new Set(['perceive', 'snap', 'snapshot']);

function isBatchParallelUnsafeCommand(cmd) {
  const meta = commandMeta(cmd);
  if (meta?.mutates === true) return true;
  return BATCH_PARALLEL_READ_STATE_COMMANDS.has(cmd);
}

function autoActionJsonArgs(cmd, args = [], enabled = false) {
  return autoActionJsonArgsForCommands(cmd, args, enabled, { commands: COMMANDS });
}

function batchStepModel(result = {}, index = 0) {
  const actionModel = maybeParseJson(result.result);
  const actionFailure = actionModel?.schema === 'chrome-cdp-ex.action.v1' && actionModel.dispatch?.ok === false;
  const diagnosis = diagnosisFromActionModel(actionModel);
  const verdict = verdictFromActionModel(actionModel);
  const errorText = result.error || (actionFailure ? actionModel.dispatch?.error : null) || '';
  const ok = result.ok === true && !actionFailure;
  const failureKind = actionFailure
    ? actionModel.effects?.failure?.kind || null
    : extractLabeledLine(errorText, 'Action failure');
  const nextCommand = actionFailure
    ? actionModel.nextHint || actionModel.effects?.failure?.nextCommand || null
    : extractLabeledLine(errorText, 'Next');
  const step = {
    index: index + 1,
    cmd: result.cmd || '',
    ok,
  };
  if (ok) {
    step.resultPreview = firstNonEmptyLine(result.result);
  } else {
    step.error = errorText || 'unknown error';
    if (failureKind) step.failureKind = failureKind;
    if (nextCommand) step.nextCommand = nextCommand;
  }
  if (diagnosis) step.diagnosis = diagnosis;
  if (verdict) step.verdict = verdict;
  return step;
}

function buildBatchResultModel(results = [], { targetId = null, mode = 'sequential' } = {}) {
  const steps = results.map((result, index) => batchStepModel(result, index));
  const failedSteps = steps.filter(step => !step.ok);
  const diagnosisAttentionSteps = steps.filter(step => step.ok && isAttentionDiagnosis(step.diagnosis));
  const verdictAttentionSteps = steps.filter(step => step.ok && isAttentionVerdict(step.verdict));
  const attentionSteps = [...new Set([...diagnosisAttentionSteps, ...verdictAttentionSteps])];
  const nextSteps = [];
  const pushNext = (command) => {
    if (command && !nextSteps.includes(command)) nextSteps.push(command);
  };
  for (const step of failedSteps) {
    for (const command of recoveryCommandsFromDiagnosis(step.diagnosis)) pushNext(command);
    for (const command of recoveryCommandsFromVerdict(step.verdict)) pushNext(command);
    pushNext(step.nextCommand);
  }
  for (const step of attentionSteps) {
    for (const command of recoveryCommandsFromDiagnosis(step.diagnosis)) pushNext(command);
    for (const command of recoveryCommandsFromVerdict(step.verdict)) pushNext(command);
  }
  if (failedSteps.length && nextSteps.length === 0) {
    nextSteps.push(targetId ? `cdp status ${targetId}` : 'cdp status <target>');
  }
  return {
    schema: 'chrome-cdp-ex.batch.v1',
    targetId,
    mode,
    counts: {
      steps: steps.length,
      ok: steps.length - failedSteps.length,
      failed: failedSteps.length,
      attention: attentionSteps.length,
    },
    steps,
    failedStep: failedSteps[0] || null,
    nextSteps,
  };
}

function parseBatchArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args;
  const parallel = tokens.includes('--parallel');
  const plain = tokens.includes('--plain');
  const compact = tokens.includes('--compact');
  const input = tokens.filter(a => a !== '--parallel' && a !== '--plain' && a !== '--compact').join(' ') || '';
  let commands;
  if (input.startsWith('[')) {
    try { commands = JSON.parse(input); } catch { throw new Error('batch: invalid JSON array'); }
    if (!Array.isArray(commands)) throw new Error('batch argument must be a JSON array');
  } else {
    commands = input.split('|').map(segment => {
      const parts = segment.trim().split(/\s+/);
      return { cmd: parts[0], args: parts.slice(1) };
    }).filter(c => c.cmd);
  }
  return {
    commands,
    parallel,
    output: fopts.format === 'json' ? 'model' : (plain ? 'plain' : compact ? 'compact' : 'legacy-json'),
  };
}

function formatBatchResults(results, format = 'json', options = {}) {
  if (format && typeof format === 'object') {
    return formatJson(buildBatchResultModel(results, format));
  }
  if (format === 'model') {
    return formatJson(buildBatchResultModel(results, options));
  }
  if (format === 'plain') {
    const lines = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`[${i + 1}/${results.length}] ${r.cmd}${r.ok ? '' : ' (error)'}`);
      if (r.ok) {
        const body = (r.result ?? '').toString();
        if (body) lines.push(...body.split('\n').map(l => '  ' + l));
      } else {
        lines.push(`  ${r.error}`);
      }
    }
    return lines.join('\n');
  }
  if (format === 'compact') {
    return results.map((r, i) => {
      const head = `[${i + 1}] ${r.cmd}`;
      if (!r.ok) return `${head}: ERROR ${r.error}`;
      const body = (r.result ?? '').toString().split('\n')[0].slice(0, 200);
      return body ? `${head}: ${body}` : `${head}: ok`;
    }).join('\n');
  }
  return JSON.stringify(results, null, 2);
}

// --- Repeat: bounded loop primitive ---
// `repeat <count> <cmd> [args...]` runs the inner command up to count times.
// Defaults to fail-fast (halt on first error) so a stale @ref or missing
// element does not waste 50 round-trips silently. `--continue` (or `-c`) keeps
// going through errors and reports the tally at the end. The cap is
// intentionally low — repeat is for "press c 5 times to advance through MUD
// dialogue", not for unbounded loops; agents that need more should drive their
// own loop with state checks between iterations.
const REPEAT_CAP = 50;
// `flow` is intentionally allowed: `repeat N flow "step1; step2; ..."` is the
// documented pattern for bounded multi-step loops (combat turns, multi-phase
// dialogues). Nesting is a single level — the inner flow runs through the
// same daemon dispatcher and cannot recurse back into repeat. `batch` stays
// blocked because its parallel/JSON modes are awkward to compose linearly,
// and `repeat`/`stop` are blocked to avoid recursion and IPC corruption.
const REPEAT_BLOCKED = new Set(['repeat', 'batch', 'stop']);

function parsePageConditionArgs(args = []) {
  const flags = new Map([
    ['--until-selector', 'selector-exists'],
    ['--until-selector-missing', 'selector-missing'],
    ['--until-text', 'text'],
  ]);
  const remainingArgs = [];
  let condition = null;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!flags.has(token)) {
      remainingArgs.push(token);
      continue;
    }
    const value = args[++i];
    if (value == null || value === '' || String(value).startsWith('--')) {
      throw new Error(`repeat: ${token} requires a value.`);
    }
    if (condition) {
      throw new Error('repeat: choose exactly one until condition.');
    }
    condition = { kind: flags.get(token), value: String(value) };
  }
  return { condition, remainingArgs };
}

function pageConditionDescription(condition = {}) {
  if (condition.kind === 'selector-exists') return `selector ${condition.value} exists`;
  if (condition.kind === 'selector-missing') return `selector ${condition.value} is missing`;
  if (condition.kind === 'text') return `text includes ${JSON.stringify(condition.value)}`;
  return 'unknown page condition';
}

async function probePageCondition(cdp, sid, condition) {
  if (!condition?.kind || !condition?.value) throw new Error('page condition requires a kind and value');
  const value = JSON.stringify(condition.value);
  let expression;
  if (condition.kind === 'selector-exists' || condition.kind === 'selector-missing') {
    const negate = condition.kind === 'selector-missing';
    expression = `JSON.stringify({ matched: ${negate ? '!' : '!!'}document.querySelector(${value}) })`;
  } else if (condition.kind === 'text') {
    expression = `JSON.stringify({ matched: ((document.body && document.body.innerText) || '').includes(${value}) })`;
  } else {
    throw new Error(`Unknown page condition: ${condition.kind}`);
  }
  const raw = await evalStr(cdp, sid, expression);
  const result = JSON.parse(raw);
  return { matched: result.matched === true, description: pageConditionDescription(condition) };
}

function parseRepeatArgs(args) {
  if (!Array.isArray(args) || args.length < 1) {
    throw new Error('repeat requires <count> <cmd> [args...]');
  }
  const parsedCondition = parsePageConditionArgs(args);
  const opts = { count: 0, cmd: null, args: [], continueOnError: false, condition: parsedCondition.condition };
  const positional = [];
  for (const a of parsedCondition.remainingArgs) {
    if (a === '--continue' || a === '-c') opts.continueOnError = true;
    else positional.push(a);
  }
  if (positional.length < 1) throw new Error('repeat requires <count> <cmd> [args...]');
  const count = parseInt(positional[0], 10);
  if (!Number.isFinite(count) || count < 1 || String(count) !== String(positional[0]).trim()) {
    throw new Error(`repeat: count must be a positive integer, got "${positional[0]}"`);
  }
  if (count > REPEAT_CAP) {
    throw new Error(`repeat: count ${count} exceeds cap ${REPEAT_CAP}. Run multiple repeats or drive your own loop with state checks.`);
  }
  opts.count = count;
  if (positional.length < 2) throw new Error('repeat: command name required after count');
  opts.cmd = positional[1];
  opts.args = positional.slice(2);
  if (REPEAT_BLOCKED.has(opts.cmd)) {
    throw new Error(`repeat: cannot wrap "${opts.cmd}" (would recurse or break IPC). Use a single-shot command (click, press, fill, ...).`);
  }
  return opts;
}

async function repeatStr({ run, probeCondition }, args) {
  const opts = parseRepeatArgs(args);
  const head = `Repeat ${opts.count}× ${opts.cmd}${opts.args.length ? ' ' + opts.args.join(' ') : ''}${opts.continueOnError ? ' (--continue)' : ''}`;
  const lines = [head];
  let okCount = 0, failCount = 0;
  for (let i = 1; i <= opts.count; i++) {
    const r = await run({ cmd: opts.cmd, args: opts.args.slice() });
    if (r && r.ok) {
      okCount++;
      const body = (r.result || '').toString().split('\n')[0].slice(0, 200);
      lines.push(body ? `[${i}/${opts.count}] ok: ${body}` : `[${i}/${opts.count}] ok`);
      if (opts.condition) {
        if (typeof probeCondition !== 'function') throw new Error('repeat: condition probe is unavailable');
        const conditionResult = await probeCondition(opts.condition);
        lines.push(`  Condition: ${conditionResult.description} — ${conditionResult.matched ? 'matched' : 'not matched'}`);
        if (conditionResult.matched) {
          lines.push(`Condition satisfied after iteration ${i}/${opts.count}`);
          lines.push(`Done: ${okCount} ok, ${failCount} failed`);
          return lines.join('\n');
        }
      }
    } else {
      failCount++;
      const errText = (r && r.error) || 'unknown error';
      lines.push(`[${i}/${opts.count}] ✗ ${errText}`);
      if (!opts.continueOnError) {
        lines.push(`Repeat halted at iteration ${i}/${opts.count} (use --continue to keep going).`);
        break;
      }
    }
  }
  lines.push(`Done: ${okCount} ok, ${failCount} failed`);
  if (opts.condition) {
    lines.push(`repeat: condition not satisfied after ${opts.count} iterations`);
    throw new Error(lines.join('\n'));
  }
  return lines.join('\n');
}

// --- Flow: sequential step runner ---
function parseFlowSteps(input) {
  if (typeof input !== 'string' || !input.trim()) return [];
  return input.split(';').map(s => s.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\s+/);
    const head = parts[0];
    if (head === 'wait') {
      const what = parts.slice(1).join(' ').toLowerCase();
      return { kind: 'wait', what };
    }
    if (head === 'assert') {
      const assertionKind = parts[1];
      const value = parts.slice(2).join(' ').replace(/^(['"])(.*)\1$/, '$2');
      const kinds = {
        selector: 'selector-exists',
        'selector-missing': 'selector-missing',
        text: 'text',
      };
      if (!kinds[assertionKind] || !value) {
        throw new Error('flow assert: use "assert selector <css>", "assert selector-missing <css>", or "assert text <value>".');
      }
      return { kind: 'assert', condition: { kind: kinds[assertionKind], value } };
    }
    return { kind: 'command', cmd: head, args: parts.slice(1) };
  });
}

function flowStepModel(step = {}, index = 0, state = {}) {
  const base = {
    index: index + 1,
    kind: step.kind || 'command',
    ok: state.ok === true,
  };
  if (step.kind === 'wait') base.wait = step.what || '';
  else if (step.kind === 'assert') base.condition = step.condition || null;
  else {
    base.cmd = step.cmd || '';
    base.args = Array.isArray(step.args) ? step.args : [];
  }
  if (state.skipped) {
    base.ok = false;
    base.skipped = true;
    return base;
  }
  if (base.ok) {
    const actionModel = maybeParseJson(state.result);
    const actionFailure = actionModel?.schema === 'chrome-cdp-ex.action.v1' && actionModel.dispatch?.ok === false;
    const diagnosis = diagnosisFromActionModel(actionModel);
    const verdict = verdictFromActionModel(actionModel);
    base.resultPreview = firstNonEmptyLine(state.result);
    if (diagnosis) base.diagnosis = diagnosis;
    if (verdict) base.verdict = verdict;
    if (actionFailure) {
      base.ok = false;
      base.error = actionModel.dispatch?.error || 'Action dispatch failed';
      if (actionModel.effects?.failure?.kind) base.failureKind = actionModel.effects.failure.kind;
      if (actionModel.nextHint || actionModel.effects?.failure?.nextCommand) {
        base.nextCommand = actionModel.nextHint || actionModel.effects.failure.nextCommand;
      }
    }
    return base;
  }
  const errorText = String(state.error || 'unknown error');
  base.error = errorText;
  const failureKind = extractLabeledLine(errorText, 'Action failure');
  const nextCommand = extractLabeledLine(errorText, 'Next');
  if (failureKind) base.failureKind = failureKind;
  if (nextCommand) base.nextCommand = nextCommand;
  return base;
}

function buildFlowResultModel({ targetId = null, input = '', steps = [], stepResults = [] } = {}) {
  const failedStep = stepResults.find(step => step.ok === false && step.skipped !== true) || null;
  const skipped = stepResults.filter(step => step.skipped === true).length;
  const failed = failedStep ? 1 : 0;
  const ok = stepResults.filter(step => step.ok === true).length;
  const diagnosisAttentionSteps = stepResults.filter(step => step.ok && isAttentionDiagnosis(step.diagnosis));
  const verdictAttentionSteps = stepResults.filter(step => step.ok && isAttentionVerdict(step.verdict));
  const attentionSteps = [...new Set([...diagnosisAttentionSteps, ...verdictAttentionSteps])];
  const nextSteps = [];
  const pushNext = (command) => {
    if (command && !nextSteps.includes(command)) nextSteps.push(command);
  };
  if (failedStep) {
    for (const command of recoveryCommandsFromDiagnosis(failedStep.diagnosis)) pushNext(command);
    for (const command of recoveryCommandsFromVerdict(failedStep.verdict)) pushNext(command);
    pushNext(failedStep.nextCommand);
  }
  if (failedStep && nextSteps.length === 0) pushNext(targetId ? `cdp status ${targetId}` : 'cdp status <target>');
  for (const step of attentionSteps) {
    for (const command of recoveryCommandsFromDiagnosis(step.diagnosis)) pushNext(command);
    for (const command of recoveryCommandsFromVerdict(step.verdict)) pushNext(command);
  }
  return {
    schema: 'chrome-cdp-ex.flow.v1',
    targetId,
    input,
    halted: !!failedStep,
    counts: {
      steps: steps.length,
      ok,
      failed,
      skipped,
      attention: attentionSteps.length,
    },
    steps: stepResults,
    failedStep,
    nextSteps,
  };
}

async function settleFlow(cdp, sid, what, pendingReqs, opts = {}) {
  const max = opts.maxMs || 10000;
  const quiet = opts.quietMs || 500;
  if (what === 'dom stable') {
    await waitForSettle(cdp, sid, max);
    return 'dom stable';
  }
  if (what === 'network idle') {
    const deadline = Date.now() + max;
    let lastBusy = Date.now();
    while (Date.now() < deadline) {
      const size = pendingReqs?.size || 0;
      if (size > 0) lastBusy = Date.now();
      else if (Date.now() - lastBusy >= quiet) return 'network idle';
      await sleep(100);
    }
    return `network idle (timeout, ${pendingReqs?.size || 0} pending)`;
  }
  throw new Error(`Unknown wait: "${what}". Use "dom stable" or "network idle".`);
}

async function flowStr({ run, settle, assertCondition }, input, { format = 'text', targetId = null } = {}) {
  const steps = parseFlowSteps(input);
  if (steps.length === 0) throw new Error('flow: no steps. Example: flow <target> "click @1; wait dom stable; summary"');
  const lines = [`Flow: ${steps.length} step(s)`];
  const stepResults = [];
  const finish = () => {
    if (format === 'json') return formatJson(buildFlowResultModel({ targetId, input, steps, stepResults }));
    return lines.join('\n');
  };
  const markSkippedAfter = (startIndex) => {
    for (let j = startIndex; j < steps.length; j++) {
      stepResults.push(flowStepModel(steps[j], j, { skipped: true }));
    }
  };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const head = step.kind === 'wait'
      ? `[${i + 1}/${steps.length}] wait ${step.what}`
      : step.kind === 'assert'
      ? `[${i + 1}/${steps.length}] assert ${pageConditionDescription(step.condition)}`
      : `[${i + 1}/${steps.length}] ${step.cmd}${step.args.length ? ' ' + step.args.join(' ') : ''}`;
    lines.push(head);
    try {
      let body;
      if (step.kind === 'wait') {
        body = await settle(step.what);
      } else if (step.kind === 'assert') {
        if (typeof assertCondition !== 'function') throw new Error('flow: assertion probe is unavailable');
        const assertion = await assertCondition(step.condition);
        if (!assertion.matched) throw new Error(`Assertion failed: ${assertion.description}`);
        body = `Assertion passed: ${assertion.description}`;
      } else {
        const r = await run(step);
        if (!r.ok) {
          stepResults.push(flowStepModel(step, i, { ok: false, error: r.error }));
          markSkippedAfter(i + 1);
          lines.push(`  ✗ ${r.error}`);
          lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
          return finish();
        }
        body = r.result ?? '';
      }
      const stepModel = flowStepModel(step, i, { ok: true, result: body });
      stepResults.push(stepModel);
      const text = (body || '').toString();
      if (text) for (const ln of text.split('\n')) lines.push('  ' + ln);
      if (!stepModel.ok) {
        markSkippedAfter(i + 1);
        lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
        return finish();
      }
    } catch (e) {
      stepResults.push(flowStepModel(step, i, { ok: false, error: e.message }));
      markSkippedAfter(i + 1);
      lines.push(`  ✗ ${e.message}`);
      lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
      return finish();
    }
  }
  return finish();
}

// --- Replay: execute record-actions artifacts ---
const REPLAY_BLOCKED = new Set(['replay', 'record-actions', 'recordactions', 'batch', 'flow', 'repeat', 'stop']);

function parseReplayArgs(args, { reader = readFileSync } = {}) {
  const fopts = parseFormatArgs((args || []).filter(a => a !== undefined && a !== null), ['text', 'json']);
  const tokens = fopts.args;
  const opts = { continueOnError: false, artifact: null, source: 'inline JSON', format: fopts.format };
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--continue' || token === '-c') {
      opts.continueOnError = true;
    } else if (token === '--json') {
      const raw = tokens.slice(i + 1).join(' ').trim();
      if (!raw) throw new Error('replay --json requires a record-actions JSON payload');
      opts.artifact = parseReplayArtifact(raw);
      opts.source = 'inline JSON';
      break;
    } else if (token === '--file' || token === '-f') {
      const filePath = tokens[++i];
      if (!filePath) throw new Error('replay --file requires a path to a record-actions JSON artifact');
      opts.artifact = parseReplayArtifact(reader(filePath, 'utf8'));
      opts.source = filePath;
    } else {
      positional.push(token);
    }
  }
  if (!opts.artifact) {
    const raw = positional.join(' ').trim();
    if (!raw) throw new Error('replay requires --json <record-actions-json> or --file <path>');
    if (raw.startsWith('{') || raw.startsWith('[')) {
      opts.artifact = parseReplayArtifact(raw);
      opts.source = 'inline JSON';
    } else {
      opts.artifact = parseReplayArtifact(reader(positional[0], 'utf8'));
      opts.source = positional[0];
    }
  }
  return opts;
}

function parseReplayArtifact(raw) {
  let artifact;
  try {
    artifact = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error(`replay: invalid JSON artifact (${e.message})`);
  }
  if (Array.isArray(artifact)) {
    artifact = { schema: 'chrome-cdp-ex.record-actions.v1', actions: artifact };
  }
  if (!artifact || typeof artifact !== 'object') throw new Error('replay: artifact must be a record-actions JSON object');
  if (artifact.schema !== 'chrome-cdp-ex.record-actions.v1') {
    throw new Error(`replay: unsupported artifact schema ${artifact.schema || '(missing)'}`);
  }
  if (!Array.isArray(artifact.actions)) throw new Error('replay: artifact.actions must be an array');
  if (artifact.environment != null && !Array.isArray(artifact.environment)) throw new Error('replay: artifact.environment must be an array when provided');
  return artifact;
}

function replayStepFromAction(action = {}) {
  const command = Array.isArray(action.command) ? action.command.map(v => String(v)) : [];
  const commandText = command.length ? formatCommandLine(command) : `${action.action || 'action'} <missing command>`;
  if (action.replayable !== true) {
    const missing = Array.isArray(action.needsInput) && action.needsInput.length
      ? action.needsInput
      : ['review'];
    return { skip: true, command, commandText, missing, reason: 'not replayable' };
  }
  if (!command.length || !command[0]) {
    return { skip: true, command, commandText, missing: ['command'], reason: 'missing command' };
  }
  if (command.includes('<redacted>')) {
    return { skip: true, command, commandText, missing: redactedCommandNeedsInput(action.action || command[0]), reason: 'redacted input' };
  }
  if (REPLAY_BLOCKED.has(command[0])) {
    return { skip: true, command, commandText, missing: ['safe command'], reason: `blocked command: ${command[0]}` };
  }
  return { cmd: command[0], args: command.slice(1), command, commandText };
}

function replayRecoveryNextSteps(targetId) {
  const target = targetId || '<target>';
  return [
    `cdp perceive ${target} -C -d 8`,
    `cdp report ${target} --format json`,
  ];
}

async function replayActionsStr({ run }, args) {
  const opts = parseReplayArgs(args);
  const actions = opts.artifact.actions;
  const environment = Array.isArray(opts.artifact.environment) ? opts.artifact.environment : [];
  const total = actions.length;
  const model = {
    schema: 'chrome-cdp-ex.replay.v1',
    source: opts.source,
    sourceTargetId: opts.artifact.targetId || null,
    sourceSessionId: opts.artifact.sessionId || null,
    continueOnError: opts.continueOnError,
    halted: false,
    counts: {
      environment: environment.length,
      actions: total,
      total: environment.length + total,
      ok: 0,
      failed: 0,
      skipped: 0,
    },
    steps: [],
    failedStep: null,
    nextSteps: [],
  };
  const lines = [
    `Replay: ${total} step(s)`,
    `Source: ${opts.source}`,
  ];
  if (environment.length) lines.push(`Environment: ${environment.length} step(s)`);
  const finish = () => {
    lines.push(`Done: ${model.counts.ok} ok, ${model.counts.failed} failed, ${model.counts.skipped} skipped`);
    if (model.failedStep) model.nextSteps = replayRecoveryNextSteps(model.sourceTargetId);
    return opts.format === 'json' ? formatJson(model) : lines.join('\n');
  };
  const recordStep = (phase, index, totalCount, step, details) => {
    const entry = {
      phase,
      index,
      total: totalCount,
      command: step.command || [],
      commandText: step.commandText,
      ok: details.ok === true,
      skipped: details.skipped === true,
    };
    if (details.resultPreview) entry.resultPreview = details.resultPreview;
    if (details.error) entry.error = details.error;
    if (step.reason) entry.reason = step.reason;
    if (step.missing?.length) entry.missing = step.missing;
    model.steps.push(entry);
    return entry;
  };
  const runReplayStep = async (step, phase, index, totalCount, label, haltText) => {
    if (step.skip) {
      model.counts.skipped++;
      lines.push(`${label} skip ${step.commandText}`);
      if (step.reason) lines.push(`  Reason: ${step.reason}`);
      if (step.missing?.length) lines.push(`  Missing: ${step.missing.join(', ')}`);
      recordStep(phase, index, totalCount, step, { skipped: true });
      return true;
    }
    lines.push(`${label} ${step.commandText}`);
    const result = await run({ cmd: step.cmd, args: step.args });
    if (result?.ok) {
      model.counts.ok++;
      const body = (result.result || '').toString().split('\n')[0].slice(0, 240);
      if (body) lines.push(`  ok: ${body}`);
      else lines.push('  ok');
      recordStep(phase, index, totalCount, step, { ok: true, resultPreview: body || null });
      return true;
    }
    model.counts.failed++;
    const error = result?.error || 'unknown error';
    lines.push(`  ✗ ${error}`);
    const failedStep = recordStep(phase, index, totalCount, step, { ok: false, error });
    if (!model.failedStep) model.failedStep = failedStep;
    if (!opts.continueOnError) {
      model.halted = true;
      lines.push(`${haltText} (use --continue to keep going).`);
      return false;
    }
    return true;
  };
  for (let i = 0; i < environment.length; i++) {
    const step = replayStepFromAction(environment[i]);
    const keepGoing = await runReplayStep(step, 'environment', i + 1, environment.length, `[env ${i + 1}/${environment.length}]`, `Replay halted at environment step ${i + 1}/${environment.length}`);
    if (!keepGoing) {
      return finish();
    }
  }
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const step = replayStepFromAction(action);
    const keepGoing = await runReplayStep(step, 'action', i + 1, total, `[${i + 1}/${total}]`, `Replay halted at step ${i + 1}/${total}`);
    if (!keepGoing) break;
  }
  return finish();
}

// --- Doctor: one-call diagnostics ---
function checkNode(version = process.version) {
  const major = parseInt(String(version).replace(/^v/, '').split('.')[0]) || 0;
  if (major >= 22) return { status: 'OK', label: 'Node', detail: `${version} (>= 22)` };
  return {
    status: 'FAIL', label: 'Node', detail: `${version} (need >= 22)`,
    hint: 'chrome-cdp-ex uses built-in WebSocket which requires Node 22+',
  };
}

function checkSkillSymlink({ home = homedir(), fs = { existsSync, lstatSync: null } } = {}) {
  const target = resolve(home, '.claude', 'skills', 'chrome-cdp-ex');
  if (!fs.existsSync(target)) {
    return {
      status: 'WARN', label: 'Skill install', detail: `${target} not found`,
      hint: 'Install with: cp -r skills/chrome-cdp-ex ~/.claude/skills/  (or use the plugin loader)',
    };
  }
  let kind = 'directory';
  try {
    const lstat = fs.lstatSync ? fs.lstatSync(target) : null;
    if (lstat?.isSymbolicLink?.()) kind = 'symlink';
  } catch {}
  return { status: 'OK', label: 'Skill install', detail: `${kind}: ${target}` };
}

function checkDaemonSockets({ list = listDaemonSockets } = {}) {
  const daemons = list();
  if (!daemons || daemons.length === 0) {
    return { status: 'OK', label: 'Daemons', detail: 'no live tab daemons', targetPrefixes: [] };
  }
  const ids = daemons.map(d => (d.targetId || '').slice(0, 8)).filter(Boolean);
  return {
    status: 'OK', label: 'Daemons',
    detail: `${daemons.length} live: ${ids.join(', ')}`,
    targetPrefixes: ids,
  };
}

function detectFdLimit({ runner = spawnSync } = {}) {
  if (IS_WINDOWS) return null;
  try {
    const res = runner('/bin/sh', ['-lc', 'ulimit -n'], { encoding: 'utf8', timeout: 1000 });
    if (res.status !== 0) return null;
    const raw = String(res.stdout || '').trim();
    if (raw === 'unlimited') return Number.POSITIVE_INFINITY;
    const limit = Number(raw);
    return Number.isFinite(limit) ? limit : null;
  } catch {
    return null;
  }
}

function fdLimitRecovery({ platform = process.platform } = {}) {
  const commands = [
    {
      scope: 'current-shell',
      command: 'ulimit -n 4096',
      reason: 'Raise the open-files limit for this terminal before starting long chrome-cdp-ex sessions.',
      requiresAdmin: false,
    },
  ];
  if (platform === 'darwin') {
    commands.push({
      scope: 'macos-login-session',
      command: 'sudo launchctl limit maxfiles 65536 200000',
      reason: 'Raise the macOS launchd limit for GUI apps and future shells; rerun doctor afterwards.',
      requiresAdmin: true,
    });
  }
  return {
    schema: 'chrome-cdp-ex.fd-limit-recovery.v1',
    strategy: 'raise-open-files-limit',
    commands,
  };
}

function checkFdLimit({ limit = detectFdLimit(), platform = process.platform } = {}) {
  const recovery = fdLimitRecovery({ platform });
  if (limit == null) {
    return {
      status: 'WARN',
      label: 'FD limit',
      detail: 'open-files limit unavailable',
      hint: 'If you see "Too many open files", rerun commands with: ulimit -n 4096',
      recovery,
    };
  }
  if (limit >= 1024) {
    const text = limit === Number.POSITIVE_INFINITY ? 'unlimited' : String(limit);
    return { status: 'OK', label: 'FD limit', detail: `${text} open files` };
  }
  return {
    status: 'WARN',
    label: 'FD limit',
    detail: `${limit} open files (low for long browser sessions)`,
    hint: 'Raise for this shell with: ulimit -n 4096',
    recovery,
  };
}

async function checkCdpReachability({ env = process.env, fetcher = fetch, host = env.CDP_HOST || process.env.CDP_HOST || '127.0.0.1' } = {}) {
  const port = env.CDP_PORT;
  const tryFetch = async (p) => {
    const res = await fetcher(`http://${host}:${p}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const describe = (info) => {
    const product = info.Browser || info.product || 'unknown browser';
    const ua = info['User-Agent'] || '';
    const m = ua.match(/Electron\/([\d.]+)/);
    return m ? `${product} (Electron ${m[1]})` : product;
  };
  if (port) {
    try {
      const info = await tryFetch(port);
      if (!info.webSocketDebuggerUrl) {
        return {
          status: 'WARN', label: 'CDP', detail: `port ${port}: no webSocketDebuggerUrl`,
          hint: 'Browser exposes /json/version but not the debugger WebSocket — toggle remote debugging again',
          host,
          port: String(port),
        };
      }
      return { status: 'OK', label: 'CDP', detail: `${host}:${port} → ${describe(info)}`, host, port: String(port) };
    } catch (e) {
      return {
        status: 'FAIL', label: 'CDP', detail: `cannot reach ${host}:${port} (${e.message})`,
        hint: `start the app with --remote-debugging-port=${port}, or unset CDP_PORT to auto-discover Chrome`,
        host,
        port: String(port),
      };
    }
  }
  // Auto-discover via DevToolsActivePort (light reuse — avoids full ws connect)
  const home = homedir();
  const localAppData = env.LOCALAPPDATA || process.env.LOCALAPPDATA || '';
  const tryPaths = [
    env.CDP_PORT_FILE,
    resolve(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
    resolve(home, 'Library/Application Support/Google/Chrome/Default/DevToolsActivePort'),
    resolve(home, '.config/google-chrome/DevToolsActivePort'),
    resolve(home, '.config/chromium/DevToolsActivePort'),
    resolve(localAppData, 'Google\\Chrome\\User Data\\DevToolsActivePort'),
  ].filter(Boolean);
  const found = tryPaths.find(p => existsSync(p));
  if (!found) {
    return {
      status: 'FAIL', label: 'CDP', detail: 'no DevToolsActivePort and no CDP_PORT set',
      hint: 'Toggle chrome://inspect/#remote-debugging in Chrome, or set CDP_PORT=<port> for an Electron app',
    };
  }
  let lines;
  try {
    lines = readFileSync(found, 'utf8').trim().split('\n');
  } catch (e) {
    return { status: 'WARN', label: 'CDP', detail: `cannot read ${found}: ${e.message}`, host };
  }
  if (lines.length < 2 || !lines[0]) {
    return { status: 'WARN', label: 'CDP', detail: `invalid DevToolsActivePort at ${found}`, host };
  }
  const discoveredPort = lines[0];
  try {
    const info = await tryFetch(discoveredPort);
    return { status: 'OK', label: 'CDP', detail: `${host}:${discoveredPort} → ${describe(info)} (auto-discovered)`, host, port: String(discoveredPort) };
  } catch (e) {
    return {
      status: 'WARN', label: 'CDP',
      detail: `DevToolsActivePort points to ${discoveredPort} but /json/version unreachable: ${e.message}`,
      hint: 'Browser may have stopped — re-toggle chrome://inspect/#remote-debugging',
      host,
      port: String(discoveredPort),
    };
  }
}

function normalizeBrowserTargetInfo(target) {
  return {
    targetId: target.targetId || target.id || '',
    type: target.type || '',
    title: target.title || '',
    url: target.url || '',
  };
}

function isDebuggablePageTarget(target) {
  return target.type === 'page'
    && target.targetId
    && !target.url.startsWith('chrome://')
    && !target.url.startsWith('edge://')
    && !target.url.startsWith('devtools://');
}

async function checkBrowserTargets({ cdp = null, env = process.env, fetcher = fetch, host = env.CDP_HOST || process.env.CDP_HOST || '127.0.0.1' } = {}) {
  if (cdp?.status !== 'OK') {
    return {
      status: 'WARN',
      label: 'Tabs',
      detail: 'skipped until CDP is reachable',
      hint: 'Fix CDP first, then rerun: cdp doctor',
      targetPrefixes: [],
    };
  }
  const port = cdp.port || env.CDP_PORT;
  const cdpHost = cdp.host || host;
  if (!port) {
    return {
      status: 'WARN',
      label: 'Tabs',
      detail: 'cannot list tabs without a CDP port',
      hint: 'Rerun: cdp doctor, then use the printed CDP/open path.',
      targetPrefixes: [],
    };
  }

  try {
    const res = await fetcher(`http://${cdpHost}:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const targets = Array.isArray(raw) ? raw.map(normalizeBrowserTargetInfo).filter(isDebuggablePageTarget) : [];
    if (targets.length === 0) {
      return {
        status: 'WARN',
        label: 'Tabs',
        detail: 'no debuggable page targets',
        hint: 'Create one with: cdp open https://example.com',
        targetPrefixes: [],
        noTargets: true,
      };
    }
    const prefixLen = getDisplayPrefixLength(targets.map(target => target.targetId));
    const targetPrefixes = targets.map(target => target.targetId.slice(0, prefixLen));
    const labels = targets.slice(0, 3).map((target, index) => {
      const title = target.title || (target.url === 'about:blank' ? '(blank tab)' : target.url || '(untitled)');
      return `${targetPrefixes[index]} ${title}`.trim();
    });
    const suffix = targets.length > labels.length ? `, +${targets.length - labels.length} more` : '';
    return {
      status: 'OK',
      label: 'Tabs',
      detail: `${targets.length} debuggable page target${targets.length === 1 ? '' : 's'}: ${labels.join(', ')}${suffix}`,
      targetPrefixes,
    };
  } catch (e) {
    return {
      status: 'WARN',
      label: 'Tabs',
      detail: `cannot list debuggable page targets (${e.message})`,
      hint: 'Run: cdp list. If it is empty, run: cdp open https://example.com',
      targetPrefixes: [],
    };
  }
}

function checkBrowserPermission({ daemons = null, tabs = null, cdp = null, environment = null } = {}) {
  const daemonPrefixes = daemons?.targetPrefixes || [];
  if (daemonPrefixes.length > 0) {
    return {
      status: 'OK',
      label: 'Permission',
      detail: `debugging approved for ${daemonPrefixes.join(', ')}`,
      severity: 'ok',
      provenCommand: `cdp perceive ${daemonPrefixes[0]} -C -d 8`,
      targetPrefixes: daemonPrefixes,
    };
  }

  const tabPrefixes = tabs?.targetPrefixes || [];
  const headless = Boolean(environment?.environment?.headlessLikely || environment?.headlessLikely);
  const cdpReachable = cdp?.status === 'OK';
  if (tabPrefixes.length > 0) {
    const target = tabPrefixes[0];
    const probe = `cdp perceive ${target} -C -d 8`;
    // CDP + tabs are enough for agents to proceed; missing daemon approval is advisory.
    return {
      status: 'WARN',
      label: 'Permission',
      detail: headless && cdpReachable
        ? `headless CDP is reachable; tab daemon not attached yet for ${target}`
        : `browser debugging approval not confirmed for ${target}`,
      hint: headless && cdpReachable
        ? `Non-blocking. Run: ${probe} (or cdp list). UI "Allow debugging?" is not required for headless sessions when CDP works.`
        : `Run: ${probe}; if Chrome asks "Allow debugging?", click Allow`,
      severity: 'advisory',
      provenCommand: cdpReachable ? `cdp list` : null,
      nextProbe: probe,
      targetPrefixes: tabPrefixes,
    };
  }

  if (tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '')) {
    return {
      status: 'WARN',
      label: 'Permission',
      detail: 'no target available to request browser debugging approval',
      hint: 'Run: cdp open https://example.com; if Chrome asks "Allow debugging?", click Allow',
      severity: 'warning',
      targetPrefixes: [],
    };
  }

  return {
    status: 'WARN',
    label: 'Permission',
    detail: 'skipped until CDP and tabs are reachable',
    hint: 'Fix CDP/tabs first, then rerun: cdp doctor',
    severity: 'warning',
    targetPrefixes: [],
  };
}

function detectRuntimeEnvironment({ platform = process.platform, env = process.env, fs = { existsSync } } = {}) {
  const displayAvailable = Boolean(env?.DISPLAY || env?.WAYLAND_DISPLAY);
  const remoteSignals = [
    env?.SSH_CONNECTION,
    env?.SSH_CLIENT,
    env?.REMOTE_CONTAINERS,
    env?.CODESPACES,
    env?.CI,
    env?.CONTAINER,
  ].filter(Boolean);
  const headlessLikely = platform === 'linux' && !displayAvailable;
  const browserCandidates = ['chrome', 'edge', 'brave']
    .map(browser => ({ browser, executable: detectBrowserPath(browser, platform, fs, env) }))
    .filter(candidate => candidate.executable);
  const preferred = browserCandidates.find(candidate => candidate.browser === 'chrome') || browserCandidates[0] || null;
  return {
    platform,
    displayAvailable,
    remoteLikely: remoteSignals.length > 0,
    headlessLikely,
    sandboxMayNeedNoSandbox: platform === 'linux' && (headlessLikely || Boolean(env?.CI) || Boolean(env?.CONTAINER)),
    browserCandidates,
    preferredBrowser: preferred,
  };
}

function environmentRecoveryCommand(envInfo) {
  const candidate = envInfo.preferredBrowser;
  if (!candidate) return null;
  const args = ['cdp spawn-debug-browser', candidate.browser];
  if (envInfo.headlessLikely) args.push('--headless');
  if (envInfo.sandboxMayNeedNoSandbox) args.push('--no-sandbox');
  args.push('--port', '9222');
  args.push('--exe', candidate.executable);
  args.push('--url', 'https://example.com');
  return args.join(' ');
}

function checkRuntimeEnvironment(opts = {}) {
  const info = detectRuntimeEnvironment(opts);
  const command = environmentRecoveryCommand(info);
  if (info.headlessLikely || info.remoteLikely) {
    const traits = [
      info.platform,
      info.remoteLikely ? 'remote/container-like' : null,
      info.headlessLikely ? 'headless/no DISPLAY' : null,
      info.preferredBrowser ? `${info.preferredBrowser.browser} at ${info.preferredBrowser.executable}` : 'no browser executable detected',
    ].filter(Boolean).join(', ');
    return {
      status: info.preferredBrowser ? 'WARN' : 'FAIL',
      label: 'Environment',
      detail: `detected ${traits}`,
      hint: command || 'Install Chrome/Chromium or pass --exe to spawn-debug-browser.',
      environment: info,
      recovery: command ? {
        strategy: 'spawn-headless-debug-browser',
        command,
        requiresUserAction: true,
        consentRequired: true,
      } : null,
    };
  }
  return {
    status: 'OK',
    label: 'Environment',
    detail: `${info.platform}${info.displayAvailable ? ', display available' : ''}`,
    environment: info,
    recovery: null,
  };
}

function reconcileRuntimeEnvironmentCheck(environment, cdp) {
  if (cdp?.status !== 'OK' || environment?.label !== 'Environment' || environment.status === 'OK') {
    return environment;
  }
  return {
    ...environment,
    status: 'OK',
    detail: `${environment.detail}; CDP reachable`,
    hint: null,
    recovery: null,
  };
}

function doctorWizardSummary(checks) {
  const wizard = doctorWizardModel(checks);
  return [
    'Wizard:',
    `  Status: ${wizard.status}`,
    `  Current step: ${wizard.currentStep}`,
    `  Golden path: ${wizard.goldenPath.join(' -> ')}`,
  ];
}

function doctorWizardModel(checks) {
  const node = checks.find(c => c.label === 'Node');
  const cdp = checks.find(c => c.label === 'CDP');
  const daemon = checks.find(c => c.label === 'Daemons');
  const tabs = checks.find(c => c.label === 'Tabs');
  const permission = checks.find(c => c.label === 'Permission');
  const target = permission?.targetPrefixes?.[0] || daemon?.targetPrefixes?.[0] || tabs?.targetPrefixes?.[0] || '<target>';
  const noTargets = tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '');

  let status = 'ready for live browser perception';
  let currentStep = `cdp perceive ${target} -C -d 8`;
  if (node?.status === 'FAIL') {
    status = 'blocked at Node.js';
    currentStep = 'install Node.js 22+ and rerun: cdp doctor';
  } else if (cdp?.status === 'FAIL') {
    status = 'blocked at browser CDP';
    currentStep = 'enable browser remote debugging, then rerun: cdp doctor';
  } else if (cdp?.status === 'WARN') {
    status = 'waiting for stable browser CDP';
    currentStep = 're-toggle browser remote debugging, then rerun: cdp doctor';
  } else if (noTargets) {
    status = 'waiting for a debuggable page';
    currentStep = 'cdp open https://example.com';
  } else if (permission?.status === 'WARN') {
    const severity = doctorCheckSeverity(permission);
    if (severity === 'advisory') {
      status = 'usable with advisory notes (CDP reachable)';
      currentStep = `cdp list; cdp perceive ${target} -C -d 8`;
    } else {
      status = 'waiting for browser debugging approval';
      currentStep = `cdp perceive ${target} -C -d 8  # click Allow if Chrome asks`;
    }
  }

  return {
    status,
    currentStep,
    goldenPath: ['doctor', 'list/open', 'perceive', 'click/fill', 'since-action evidence', 'report'],
    commands: doctorNextStepCommands(checks),
  };
}

function doctorWarningCommands(checks) {
  const fd = checks.find(c => c.label === 'FD limit');
  const warnings = [];
  if (fd?.status === 'WARN') {
    const commands = Array.isArray(fd.recovery?.commands) && fd.recovery.commands.length
      ? fd.recovery.commands
      : [{ scope: 'current-shell', command: 'ulimit -n 4096', reason: fd.detail || 'open-files limit is low for long browser sessions', requiresAdmin: false }];
    warnings.push({
      label: 'FD limit',
      command: commands[0].command,
      reason: fd.detail || 'open-files limit is low for long browser sessions',
      commands,
    });
  }
  return warnings;
}

function doctorRecommendationModel(checks) {
  const node = checks.find(c => c.label === 'Node');
  const cdp = checks.find(c => c.label === 'CDP');
  const environment = checks.find(c => c.label === 'Environment');
  const daemon = checks.find(c => c.label === 'Daemons');
  const tabs = checks.find(c => c.label === 'Tabs');
  const permission = checks.find(c => c.label === 'Permission');
  const target = permission?.targetPrefixes?.[0] || daemon?.targetPrefixes?.[0] || tabs?.targetPrefixes?.[0] || '<target>';
  const noTargets = tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '');
  const base = {
    source: 'doctor-onboarding',
    stage: 'perceive',
    run: `cdp perceive ${target} -C -d 8`,
    ask: null,
    after: `cdp click ${target} @ref  # or: cdp fill ${target} <selector> <text>`,
    requiresUserAction: false,
    consentRequired: false,
    reason: 'ready for live browser perception',
    commands: doctorNextStepCommands(checks),
    warnings: doctorWarningCommands(checks),
  };

  if (node?.status === 'FAIL') {
    return {
      ...base,
      stage: 'node',
      run: null,
      ask: 'Install Node.js 22+.',
      after: 'cdp doctor',
      requiresUserAction: true,
      reason: node.detail || null,
    };
  }
  if (cdp?.status === 'FAIL') {
    if (environment?.recovery?.command) {
      return {
        ...base,
        stage: 'browser-cdp',
        run: environment.recovery.command,
        ask: 'Approve launching an isolated local debug browser profile, then run: cdp list.',
        after: 'cdp list',
        requiresUserAction: true,
        consentRequired: true,
        reason: `${cdp.detail || 'Chrome is not reachable.'} Environment looks ${environment.detail || 'headless/remote'}.`,
      };
    }
    return {
      ...base,
      stage: 'browser-cdp',
      run: 'cdp spawn-debug-browser edge --port 9222 --url https://example.com',
      ask: 'Open chrome://inspect/#remote-debugging or edge://inspect, enable remote debugging, then run: cdp doctor.',
      after: 'cdp list',
      requiresUserAction: true,
      consentRequired: true,
      reason: cdp.detail || null,
    };
  }
  if (cdp?.status === 'WARN') {
    return {
      ...base,
      stage: 'browser-cdp',
      run: 'cdp doctor',
      ask: 'Re-toggle browser remote debugging, or restart the app with CDP_PORT set.',
      after: 'cdp list',
      requiresUserAction: true,
      reason: cdp.detail || null,
    };
  }
  if (noTargets) {
    return {
      ...base,
      stage: 'open-page',
      run: 'cdp open https://example.com',
      ask: null,
      after: 'cdp perceive <target-from-open> -C -d 8',
      reason: tabs?.detail || null,
    };
  }
  if (permission?.status === 'WARN') {
    const severity = doctorCheckSeverity(permission);
    if (severity === 'advisory') {
      return {
        ...base,
        stage: 'perceive',
        run: `cdp perceive ${target} -C -d 8`,
        ask: null,
        after: `cdp click ${target} @ref  # or: cdp fill ${target} <selector> <text>`,
        requiresUserAction: false,
        reason: permission.detail || 'CDP is usable; permission approval is advisory until a tab daemon attaches.',
      };
    }
    return {
      ...base,
      stage: 'browser-permission',
      run: `cdp perceive ${target} -C -d 8`,
      ask: 'Click Allow if Chrome asks.',
      after: `cdp click ${target} @ref  # or: cdp fill ${target} <selector> <text>`,
      requiresUserAction: true,
      reason: permission.detail || null,
    };
  }
  return base;
}

function doctorRecommendationLines(checks) {
  const recommendation = doctorRecommendationModel(checks);
  const lines = ['Recommendation:'];
  if (recommendation.run) {
    const consent = recommendation.consentRequired ? '  (ask user first)' : '';
    lines.push(`  Run: ${recommendation.run}${consent}`);
  }
  if (recommendation.ask) lines.push(`  Ask: ${recommendation.ask}`);
  if (recommendation.after) lines.push(`  Then: ${recommendation.after}`);
  for (const warning of recommendation.warnings || []) {
    const commands = Array.isArray(warning.commands) && warning.commands.length
      ? warning.commands
      : [{ command: warning.command, reason: warning.reason, requiresAdmin: false }];
    for (const command of commands) {
      if (!command.command) continue;
      const admin = command.requiresAdmin ? ' (requires admin)' : '';
      lines.push(`  Long session note: ${command.command}${admin}  # ${command.reason || warning.reason}`);
    }
  }
  return lines;
}

function doctorNextSteps(checks) {
  const failures = checks.filter(c => c.status === 'FAIL');
  const cdp = checks.find(c => c.label === 'CDP');
  const node = checks.find(c => c.label === 'Node');
  const environment = checks.find(c => c.label === 'Environment');
  const fd = checks.find(c => c.label === 'FD limit');
  const daemon = checks.find(c => c.label === 'Daemons');
  const tabs = checks.find(c => c.label === 'Tabs');
  const liveTarget = daemon?.targetPrefixes?.[0] || tabs?.targetPrefixes?.[0] || '<target>';
  const noTargets = tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '');
  const lines = ['', 'Next steps:'];
  if (node?.status === 'FAIL') {
    lines.push('  1. Install Node.js 22+ and rerun: cdp doctor');
    return lines;
  }
  if (cdp?.status === 'FAIL') {
    if (environment?.recovery?.command) {
      lines.push(`  1. ${environment.recovery.command}`);
      lines.push('  2. Then run: cdp list');
      lines.push('  3. Existing browser alternative: open chrome://inspect/#remote-debugging, enable remote debugging, then rerun: cdp doctor');
    } else {
      lines.push('  1. Existing browser: open chrome://inspect/#remote-debugging, enable remote debugging, then rerun: cdp doctor');
      lines.push('  2. Isolated profile: cdp spawn-debug-browser edge --port 9222 --url https://example.com');
      lines.push('  3. Then run: cdp list');
    }
    return lines;
  }
  if (cdp?.status === 'WARN') {
    lines.push('  1. Re-toggle browser remote debugging, or restart the app with CDP_PORT set.');
    lines.push('  2. If Chrome asks "Allow debugging?", click Allow, then rerun: cdp list');
  } else {
    if (noTargets) {
      lines.push('  1. cdp open https://example.com');
      lines.push('  2. If Chrome asks "Allow debugging?", click Allow; open waits up to 60s.');
      lines.push('  3. Use the target id printed by open: cdp perceive <target-from-open> -C -d 8');
      lines.push('  4. cdp click <target-from-open> @ref  # or: cdp fill <target-from-open> <selector> <text>');
      lines.push('  5. cdp perceive <target-from-open> --since-action');
      lines.push('  6. cdp report <target-from-open>');
    } else {
      lines.push('  1. cdp list');
      if (!tabs?.targetPrefixes?.length) lines.push('  2. If list is empty: cdp open https://example.com');
      lines.push(`  ${tabs?.targetPrefixes?.length ? '2' : '3'}. cdp perceive ${liveTarget} -C -d 8`);
      lines.push(`  ${tabs?.targetPrefixes?.length ? '3' : '4'}. cdp click ${liveTarget} @ref  # or: cdp fill ${liveTarget} <selector> <text>`);
      lines.push(`  ${tabs?.targetPrefixes?.length ? '4' : '5'}. cdp perceive ${liveTarget} --since-action`);
      lines.push(`  ${tabs?.targetPrefixes?.length ? '5' : '6'}. cdp report ${liveTarget}`);
    }
  }
  if (fd?.status === 'WARN') {
    lines.push('  Note: for long sessions, use: ulimit -n 4096');
  }
  if (failures.length === 0) {
    lines.push('  Goal: doctor -> list/open -> perceive -> click/fill -> since-action evidence -> report');
  }
  return lines;
}

function formatDoctorReport(checks) {
  const model = buildDoctorModel(checks);
  const lines = ['chrome-cdp-ex doctor'];
  lines.push(...doctorWizardSummary(checks), '', ...doctorRecommendationLines(checks), '', 'Checks:');
  for (const c of model.checks) {
    const tag = c.status.padEnd(4);
    lines.push(`  [${tag}] ${c.label}: ${c.detail}`);
    if (c.severity && c.severity !== 'ok') lines.push(`         severity: ${c.severity}`);
    if (c.hint) lines.push(`         hint: ${c.hint}`);
  }
  if (model.readiness === 'ready') lines.push('Ready.');
  else if (model.readiness === 'usable-with-warnings') {
    lines.push(`Usable with warnings (${model.warnings} warning${model.warnings === 1 ? '' : 's'}, ${model.advisories} advisor${model.advisories === 1 ? 'y' : 'ies'}).`);
  } else {
    lines.push(`Blocked: ${model.failures} failure${model.failures === 1 ? '' : 's'}${model.warnings ? `, ${model.warnings} warning${model.warnings === 1 ? '' : 's'}` : ''}.`);
  }
  if (model.provenCommand) lines.push(`Proven / next probe: ${model.provenCommand}`);
  lines.push(...doctorNextSteps(checks));
  return lines.join('\n');
}

function doctorCheckSeverity(check = {}) {
  if (check.severity) return check.severity;
  if (check.status === 'FAIL') return 'blocking';
  if (check.status === 'WARN') {
    // Permission without a live daemon is advisory when CDP/tabs are otherwise usable.
    if (check.label === 'Permission' && !/no target|skipped until/i.test(check.detail || '')) return 'advisory';
    return 'warning';
  }
  return 'ok';
}

function doctorStatusSummary(checks) {
  const annotated = (checks || []).map(check => ({
    ...check,
    severity: doctorCheckSeverity(check),
  }));
  const failures = annotated.filter(c => c.status === 'FAIL' || c.severity === 'blocking').length;
  const warnings = annotated.filter(c => c.severity === 'warning').length;
  const advisories = annotated.filter(c => c.severity === 'advisory').length;
  let readiness = 'ready';
  if (failures > 0) readiness = 'blocked';
  else if (warnings > 0 || advisories > 0) readiness = 'usable-with-warnings';
  return {
    status: readiness,
    readiness,
    ready: readiness === 'ready',
    failures,
    warnings,
    actionableWarnings: warnings,
    advisories,
  };
}

function stripDoctorStepPrefix(line) {
  return String(line || '')
    .trim()
    .replace(/^\d+\.\s*/, '')
    .replace(/^Then run:\s*/i, '')
    .replace(/^If list is empty:\s*/i, '')
    .replace(/^Use the target id printed by open:\s*/i, '')
    .trim();
}

function doctorNextStepCommands(checks) {
  return doctorNextSteps(checks)
    .map(stripDoctorStepPrefix)
    .filter(line => line.startsWith('cdp '));
}

function buildDoctorModel(checks) {
  const summary = doctorStatusSummary(checks);
  const annotatedChecks = checks.map(check => ({ ...check, severity: doctorCheckSeverity(check) }));
  const recommendation = doctorRecommendationModel(checks);
  const cdpOk = annotatedChecks.find(c => c.label === 'CDP')?.status === 'OK';
  const tabsOk = annotatedChecks.find(c => c.label === 'Tabs')?.status === 'OK';
  const permission = annotatedChecks.find(c => c.label === 'Permission');
  const provenCommand = cdpOk && tabsOk
    ? (permission?.status === 'OK'
      ? (permission.targetPrefixes?.[0] ? `cdp perceive ${permission.targetPrefixes[0]} -C -d 8` : 'cdp list')
      : (permission?.hint?.match(/cdp \S.+/)?.[0] || recommendation?.run || 'cdp list'))
    : (recommendation?.run || null);
  return {
    schema: 'chrome-cdp-ex.doctor.v1',
    ...summary,
    provenCommand,
    wizard: doctorWizardModel(checks),
    recommendation,
    checks: annotatedChecks,
    nextSteps: doctorNextStepCommands(checks),
  };
}

function formatDoctorOutput(checks, { format = 'text' } = {}) {
  if (format === 'json') return formatJson(buildDoctorModel(checks));
  return formatDoctorReport(checks);
}

async function runDoctorChecks(opts = {}) {
  const safeLstat = (p) => { try { return lstatSync(p); } catch { return null; } };
  const fs = opts.fs || { existsSync, lstatSync: safeLstat };
  const checks = [];
  checks.push(checkNode(opts.nodeVersion));
  checks.push(checkSkillSymlink({ home: opts.home, fs }));
  checks.push(checkDaemonSockets({ list: opts.listDaemons }));
  checks.push(checkFdLimit({ limit: opts.fdLimit, platform: opts.platform }));
  checks.push(checkRuntimeEnvironment({ platform: opts.platform, env: opts.env, fs }));
  const cdp = await checkCdpReachability({ env: opts.env, fetcher: opts.fetcher, host: opts.host });
  checks[4] = reconcileRuntimeEnvironmentCheck(checks[4], cdp);
  checks.push(cdp);
  const tabs = await checkBrowserTargets({ cdp, env: opts.env, fetcher: opts.fetcher, host: opts.host });
  checks.push(tabs);
  checks.push(checkBrowserPermission({
    daemons: checks.find(c => c.label === 'Daemons'),
    tabs,
    cdp,
    environment: checks.find(c => c.label === 'Environment'),
  }));
  return checks;
}

async function doctorStr(opts = {}) {
  const checks = await runDoctorChecks(opts);
  return formatDoctorOutput(checks, { format: opts.format || 'text' });
}

// ---------------------------------------------------------------------------
// spawn-debug-browser: launch a browser with --remote-debugging-port using a
// disposable user-data-dir. macOS reviewer feedback: previous skill docs said
// to never suggest --remote-debugging-port, but the only way to debug a
// fresh-install Chrome/Edge without touching the user's main profile is to
// spawn an isolated debug profile. This helper keeps that path predictable.
// ---------------------------------------------------------------------------

const DEFAULT_BROWSER_PATHS = {
  darwin: {
    edge:   ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    brave:  ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  },
  linux: {
    edge:   ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge-dev'],
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    brave:  ['/usr/bin/brave-browser', '/usr/bin/brave'],
  },
  win32: {
    edge:   [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    chrome: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    brave: [
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
  },
};

function parseSpawnDebugBrowserArgs(args, env = process.env) {
  const fopts = parseFormatArgs(args || [], ['text', 'json']);
  const opts = {
    browser: (env && env.CDP_DEBUG_BROWSER) || 'edge',
    port: 9222,
    host: DEFAULT_CDP_HOST,
    url: null,
    profileDir: null,
    executable: null,
    headless: false,
    noSandbox: false,
    disableGpu: false,
    waitMs: DEFAULT_SPAWN_READY_TIMEOUT_MS,
    format: fopts.format,
  };
  const tokens = (fopts.args || []).filter(a => a !== undefined && a !== null);
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === '--port' || a === '-p') opts.port = parseInt(tokens[++i]) || 9222;
    else if (a === '--host') opts.host = tokens[++i] || opts.host;
    else if (a === '--url' || a === '-u') opts.url = tokens[++i];
    else if (a === '--profile-dir') opts.profileDir = tokens[++i];
    else if (a === '--browser') opts.browser = (tokens[++i] || opts.browser).toLowerCase();
    else if (a === '--exe' || a === '--executable') opts.executable = tokens[++i];
    else if (a === '--headless') opts.headless = 'new';
    else if (String(a).startsWith('--headless=')) opts.headless = String(a).slice('--headless='.length) || 'new';
    else if (a === '--no-sandbox') opts.noSandbox = true;
    else if (a === '--disable-gpu') opts.disableGpu = true;
    else if (a === '--wait-ms') opts.waitMs = parseNonNegativeInteger(tokens[++i], 'spawn-debug-browser: --wait-ms');
    else if (String(a).startsWith('--wait-ms=')) opts.waitMs = parseNonNegativeInteger(String(a).slice('--wait-ms='.length), 'spawn-debug-browser: --wait-ms');
    else if (['edge','chrome','brave','google-chrome','msedge','chromium'].includes(a.toLowerCase())) {
      const norm = a.toLowerCase();
      if (norm === 'msedge') opts.browser = 'edge';
      else if (norm === 'google-chrome' || norm === 'chromium') opts.browser = 'chrome';
      else opts.browser = norm;
    }
  }
  if (!opts.profileDir) {
    const tmp = (env && env.TMPDIR) || '/tmp';
    opts.profileDir = `${tmp.replace(/\/$/, '')}/chrome-cdp-ex-${opts.browser}-debug-profile-${opts.port}`;
  }
  return opts;
}

async function listSpawnedDebugTargets({ port, host = DEFAULT_CDP_HOST, fetcher = fetch } = {}) {
  try {
    const res = await fetcher(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const raw = await res.json();
    return Array.isArray(raw)
      ? raw.map(normalizeBrowserTargetInfo).filter(isDebuggablePageTarget)
      : [];
  } catch {
    return [];
  }
}

function pickSpawnedTarget(pages = [], url = null) {
  if (!pages.length) return null;
  if (url) {
    try {
      return selectPageTarget(pages, { url, exact: false }).page;
    } catch {
      // fall through to ranked pick
    }
  }
  return rankPageTargets(pages)[0] || null;
}

function buildSpawnDebugBrowserModel(plan, readiness, { child = null, target = null } = {}) {
  const targetId = target?.targetId || null;
  const targetPrefix = targetId ? String(targetId).slice(0, getDisplayPrefixLength([targetId])) : null;
  const nextCommand = targetPrefix
    ? `CDP_PORT=${plan.port} cdp perceive ${targetPrefix} -C -d 8`
    : `CDP_PORT=${plan.port} cdp list`;
  return {
    schema: 'chrome-cdp-ex.spawn-debug-browser.v1',
    ready: readiness?.ok === true,
    browser: plan.browser,
    pid: child?.pid || null,
    profileDir: plan.profileDir,
    host: plan.host,
    port: plan.port,
    url: plan.url || target?.url || null,
    product: readiness?.product || null,
    targetId,
    targetPrefix,
    title: target?.title || null,
    nextCommand,
    cleanup: {
      stopHint: `CDP_PORT=${plan.port} cdp stop${targetPrefix ? ` ${targetPrefix}` : ''}`,
      deleteProfile: `rm -rf ${plan.profileDir}`,
    },
  };
}

function formatSpawnDebugBrowserOutput(model, { format = 'text' } = {}) {
  if (format === 'json') return formatJson(model);
  const lines = [
    `Spawned ${model.browser} debug profile on CDP_PORT=${model.port} (pid ${model.pid || '?'})`,
    `  CDP ready:  ${model.product || `${model.host}:${model.port}`}`,
    `  Executable: (see profile)`,
    `  Profile:    ${model.profileDir}`,
  ];
  if (model.url) lines.push(`  URL:        ${model.url}`);
  if (model.targetPrefix) {
    lines.push(`  Target:     ${model.targetPrefix}${model.title ? `  ${model.title}` : ''}`);
  }
  lines.push('');
  lines.push(`Next: ${model.nextCommand}`);
  lines.push(`Stop/cleanup: ${model.cleanup.stopHint}; then ${model.cleanup.deleteProfile}`);
  lines.push(`(Profile is disposable — delete ${model.profileDir} to reset.)`);
  return lines.join('\n');
}

const BROWSER_COMMANDS = {
  edge: ['microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-dev', 'msedge'],
  chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'],
  brave: ['brave-browser', 'brave'],
};

function findOnPath(commands, env = process.env, fs = { existsSync }) {
  const dirs = String(env?.PATH || '').split(delimiter).filter(Boolean);
  for (const cmd of commands || []) {
    for (const dir of dirs) {
      const candidate = resolve(dir, cmd);
      if (fs.existsSync(candidate)) return candidate;
      if (IS_WINDOWS && fs.existsSync(candidate + '.exe')) return candidate + '.exe';
    }
  }
  return null;
}

function detectBrowserPath(browser, platform = process.platform, fs = { existsSync }, env = process.env) {
  const list = (DEFAULT_BROWSER_PATHS[platform] || {})[browser] || [];
  for (const candidate of list) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return findOnPath(BROWSER_COMMANDS[browser] || [], env, fs);
}

function buildSpawnDebugBrowserPlan(opts, platform = process.platform, fs = { existsSync }, env = process.env) {
  const exe = opts.executable || detectBrowserPath(opts.browser, platform, fs, env);
  if (!exe || !fs.existsSync(exe)) {
    const list = [
      ...((DEFAULT_BROWSER_PATHS[platform] || {})[opts.browser] || []),
      ...((BROWSER_COMMANDS[opts.browser] || []).map(c => `$PATH:${c}`)),
    ];
    const tried = list.length ? list.join(', ') : '(no candidates configured for this platform)';
    throw new Error(`spawn-debug-browser: cannot find ${opts.browser} executable. Tried: ${tried}. Use --exe /path/to/browser, set CDP_DEBUG_BROWSER, or install it on PATH.`);
  }
  const args = [
    `--remote-debugging-address=${opts.host || DEFAULT_CDP_HOST}`,
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (opts.headless) args.push(`--headless=${opts.headless === true ? 'new' : opts.headless}`);
  if (opts.noSandbox) args.push('--no-sandbox');
  if (opts.disableGpu) args.push('--disable-gpu');
  if (opts.url) args.push(opts.url);
  return { exe, args, profileDir: opts.profileDir, port: opts.port, host: opts.host || DEFAULT_CDP_HOST, url: opts.url, browser: opts.browser, waitMs: opts.waitMs };
}

function captureSpawnOutput(child, maxBytes = 4096) {
  const output = { stdout: '', stderr: '' };
  for (const key of ['stdout', 'stderr']) {
    const stream = child?.[key];
    if (!stream?.on) continue;
    try { stream.setEncoding?.('utf8'); } catch {}
    stream.on('data', chunk => {
      output[key] = (output[key] + String(chunk)).slice(-maxBytes);
    });
  }
  return output;
}

async function waitForSpawnedCdp({ port, host = DEFAULT_CDP_HOST, timeoutMs = DEFAULT_SPAWN_READY_TIMEOUT_MS, child = null, fetcher = fetch, output = null } = {}) {
  const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_SPAWN_READY_TIMEOUT_MS, 0), 120000);
  const deadline = Date.now() + timeout;
  let exited = false;
  let exitCode = null;
  let signal = null;
  let lastError = null;
  if (child?.once) {
    child.once('exit', (code, sig) => {
      exited = true;
      exitCode = code;
      signal = sig || null;
    });
  }
  while (Date.now() <= deadline) {
    if (exited) {
      return {
        ok: false,
        exited: true,
        exitCode,
        signal,
        stdout: output?.stdout || '',
        stderr: output?.stderr || '',
      };
    }
    try {
      const res = await fetcher(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        const info = await res.json().catch(() => ({}));
        return {
          ok: true,
          port,
          host,
          product: info.Browser || info.product || null,
          webSocketDebuggerUrl: info.webSocketDebuggerUrl || null,
        };
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e.message || String(e);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(100, remainingMs));
  }
  return {
    ok: false,
    timeout: true,
    port,
    host,
    timeoutMs: timeout,
    error: lastError,
    stdout: output?.stdout || '',
    stderr: output?.stderr || '',
  };
}

function formatSpawnDebugBrowserReadinessFailure(plan, readiness) {
  const lines = [];
  if (readiness?.exited) {
    lines.push(`spawn-debug-browser: ${plan.browser} exited early before CDP became reachable (exit ${readiness.exitCode ?? 'unknown'}${readiness.signal ? `, signal ${readiness.signal}` : ''}).`);
  } else {
    lines.push(`spawn-debug-browser: CDP was not reachable on ${plan.host}:${plan.port} within ${formatDuration(readiness?.timeoutMs || plan.waitMs)}.`);
  }
  if (readiness?.stderr) lines.push(`stderr: ${readiness.stderr.trim()}`);
  if (readiness?.stdout) lines.push(`stdout: ${readiness.stdout.trim()}`);
  lines.push(`Try: cdp spawn-debug-browser ${plan.browser} --headless --no-sandbox --port ${plan.port} --exe ${plan.exe}${plan.url ? ` --url ${plan.url}` : ''}`);
  return lines.join('\n');
}

async function probeTcpPort({ host = DEFAULT_CDP_HOST, port, timeoutMs = 500, connect = options => net.createConnection(options) } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`spawn-debug-browser: invalid port ${port}`);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({ host, port: Number(port) });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.removeAllListeners?.();
      socket?.destroy?.();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`spawn-debug-browser: could not determine whether ${host}:${port} is free (probe timed out).`)), timeoutMs);
    socket.once('connect', () => finish(resolve, { occupied: true }));
    socket.once('error', error => {
      if (error?.code === 'ECONNREFUSED') finish(resolve, { occupied: false });
      else finish(reject, new Error(`spawn-debug-browser: could not probe ${host}:${port} (${error?.message || error}).`));
    });
  });
}

async function spawnDebugBrowserStr(args, env = process.env, deps = {}) {
  const platform = deps.platform || process.platform;
  const fs = deps.fs || { existsSync, mkdirSync };
  const launcher = deps.spawn || spawn;
  const probePort = deps.probeTcpPort || probeTcpPort;
  const waitForCdp = deps.waitForSpawnedCdp || waitForSpawnedCdp;
  const listTargets = deps.listSpawnedDebugTargets || listSpawnedDebugTargets;
  const fetcher = deps.fetcher || fetch;
  const opts = parseSpawnDebugBrowserArgs(args, env);
  const plan = buildSpawnDebugBrowserPlan(opts, platform, fs, env);
  const portState = await probePort({ host: plan.host, port: plan.port });
  if (portState?.occupied) {
    throw new Error(`spawn-debug-browser: port ${plan.port} is already in use on ${plan.host}. Choose another port with --port <N>.`);
  }
  try { fs.mkdirSync(plan.profileDir, { recursive: true }); } catch {}
  const child = launcher(plan.exe, plan.args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = captureSpawnOutput(child);
  const readiness = await waitForCdp({
    port: plan.port,
    host: plan.host,
    timeoutMs: plan.waitMs,
    child,
    output,
    fetcher,
  });
  if (!readiness.ok) {
    throw new Error(formatSpawnDebugBrowserReadinessFailure(plan, readiness));
  }
  child.stdout?.unref?.();
  child.stderr?.unref?.();
  child.unref?.();
  const pages = await listTargets({ port: plan.port, host: plan.host, fetcher });
  const target = pickSpawnedTarget(pages, plan.url);
  const model = buildSpawnDebugBrowserModel(plan, readiness, { child, target });
  // Prefer executable path in text mode for operators.
  if (opts.format !== 'json') {
    const text = formatSpawnDebugBrowserOutput(model, { format: 'text' })
      .replace('  Executable: (see profile)', `  Executable: ${plan.exe}`);
    return text;
  }
  return formatSpawnDebugBrowserOutput(model, { format: 'json' });
}

function overlayDetectorScript({ targetPoint = null } = {}) {
  const targetJson = JSON.stringify(targetPoint || null);
  return `(function() {
    const targetPoint = ${targetJson};
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    function visible(el) {
      if (!el || el.id === '__cdp_annot_overlay__') return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    }
    function selectorFor(el) {
      if (!el) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      const tag = el.tagName ? el.tagName.toLowerCase() : 'node';
      const cls = typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).map(CSS.escape).join('.')
        : '';
      return tag + cls;
    }
    function shortText(el) {
      return (el?.getAttribute?.('aria-label') || el?.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 80);
    }
    function pointInRect(point, rect) {
      return !!point && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    }
    function elementInfo(el, kind, target) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), Math.max(vw - 1, 0));
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), Math.max(vh - 1, 0));
      const topAtCenter = document.elementFromPoint(cx, cy);
      const topAtTarget = target ? document.elementFromPoint(target.x, target.y) : null;
      return {
        kind,
        selector: selectorFor(el),
        role: el.getAttribute('role') || '',
        label: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '',
        text: shortText(el),
        tag: el.tagName,
        position: cs.position,
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        coversViewport: r.left <= 8 && r.top <= 8 && r.right >= vw - 8 && r.bottom >= vh - 8,
        coversTarget: pointInRect(target, r),
        topAtCenter: topAtCenter === el || el.contains(topAtCenter),
        topAtTarget: topAtTarget === el || el.contains(topAtTarget),
      };
    }
    function isDialog(el) {
      return el.matches('[role="dialog"], dialog, [aria-modal="true"]');
    }
    const seen = new Set();
    const overlays = [];
    function add(el, kind) {
      if (!visible(el) || seen.has(el)) return;
      seen.add(el);
      const info = elementInfo(el, kind, targetPoint);
      const hasPointer = info.pointerEvents !== 'none';
      const blocksTarget = !!targetPoint && info.coversTarget && hasPointer && (info.topAtTarget || isDialog(el));
      const blocksPage = !targetPoint && hasPointer && (isDialog(el) || info.coversViewport);
      if (isDialog(el) || blocksTarget || blocksPage) overlays.push({ ...info, blocking: blocksTarget || blocksPage || isDialog(el) });
    }
    for (const el of document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')) add(el, 'dialog');
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      add(el, el.getAttribute('aria-modal') === 'true' ? 'dialog' : 'overlay');
      if (overlays.length >= 20) break;
    }
    overlays.sort((a, b) => {
      const za = Number.parseInt(a.zIndex, 10);
      const zb = Number.parseInt(b.zIndex, 10);
      const zcmp = (Number.isFinite(zb) ? zb : 0) - (Number.isFinite(za) ? za : 0);
      if (zcmp) return zcmp;
      return (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h);
    });
    const target = targetPoint ? { ...targetPoint, blocked: false, topElement: null } : null;
    if (targetPoint) {
      const top = document.elementFromPoint(targetPoint.x, targetPoint.y);
      if (top) target.topElement = elementInfo(top, isDialog(top) ? 'dialog' : 'top-element', targetPoint);
      const blocker = overlays.find(o => o.coversTarget && (o.topAtTarget || o.kind === 'dialog' || o.blocking));
      if (blocker) {
        target.blocked = true;
        target.topElement = { kind: blocker.kind, selector: blocker.selector, text: blocker.label || blocker.text || blocker.tag };
      }
    }
    const blocking = overlays.some(o => o.blocking) || !!target?.blocked;
    return JSON.stringify({
      schema: 'chrome-cdp-ex.overlays.v1',
      viewport: { width: vw, height: vh },
      target,
      overlayCount: overlays.length,
      blocking,
      overlays: overlays.slice(0, 10),
      nextCommand: null,
    });
  })()`;
}

function formatOverlayRect(rect = {}) {
  return `(${Math.round(rect.x || 0)},${Math.round(rect.y || 0)} ${Math.round(rect.w || 0)}×${Math.round(rect.h || 0)})`;
}

function overlayElementLabel(element = {}) {
  const selector = element.selector || '<unknown>';
  const label = element.label || element.text || element.tag || '';
  return `[${element.kind || 'overlay'}] ${selector}${label ? ` "${label}"` : ''}`;
}

function formatOverlayReport(model, targetId) {
  const lines = [`Overlay detector: ${model.blocking ? 'blocking' : 'clear'}`];
  if (model.target) {
    const target = model.target;
    const status = target.blocked && target.topElement
      ? `blocked by ${overlayElementLabel(target.topElement)}`
      : 'not blocked';
    lines.push(`Target: ${target.input || '(point)'} at (${Math.round(target.x)},${Math.round(target.y)}) — ${status}`);
  }
  if (!model.overlays || model.overlays.length === 0) {
    lines.push('No visible blocking overlays/dialogs detected.');
  } else {
    lines.push(`Overlays: ${model.overlays.length}`);
    for (const [i, overlay] of model.overlays.entries()) {
      const role = overlay.role ? ` role=${overlay.role}` : '';
      const z = overlay.zIndex != null ? ` z=${overlay.zIndex}` : '';
      const pointer = overlay.pointerEvents ? ` pointer=${overlay.pointerEvents}` : '';
      const target = overlay.coversTarget ? ' covers-target' : '';
      lines.push(`${i + 1}. [${overlay.kind || 'overlay'}] ${overlay.selector || '<unknown>'}${role}${z}${pointer} rect=${formatOverlayRect(overlay.rect)}${target}`);
      const text = overlay.label || overlay.text;
      if (text) lines.push(`   Text: ${text}`);
    }
  }
  const next = model.blocking
    ? (model.nextCommand || `cdp dismiss-modal ${targetId}`)
    : 'continue; if click still fails, run `status` or `perceive --since-action` before retrying';
  lines.push(`Next: ${next}`);
  return lines.join('\n');
}

async function resolveOverlayTargetPoint(cdp, sid, targetArg, refMap, refState) {
  if (!targetArg) return null;
  if (isRef(targetArg)) {
    const rect = await resolveRefRectNoScroll(cdp, sid, refMap, targetArg, refState);
    return {
      input: targetArg,
      x: Math.round((Number(rect.x) || 0) + (Number(rect.w) || 0) / 2),
      y: Math.round((Number(rect.y) || 0) + (Number(rect.h) || 0) / 2),
      descriptor: `<${rect.tag || '?'}> "${rect.text || ''}"`,
    };
  }
  const raw = await evalStr(cdp, sid, `(function() {
    const el = document.querySelector(${JSON.stringify(targetArg)});
    if (!el) return JSON.stringify({ ok: false, error: 'Element not found: ' + ${JSON.stringify(targetArg)} });
    const rect = el.getBoundingClientRect();
    return JSON.stringify({
      ok: true,
      input: ${JSON.stringify(targetArg)},
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      descriptor: '<' + el.tagName + '> "' + (el.textContent || '').trim().substring(0, 80) + '"'
    });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  delete parsed.ok;
  return parsed;
}

async function overlayStr(cdp, sid, targetId, args = [], refMap = new Map(), refState = null) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const targetArg = fopts.args[0] || null;
  const targetPoint = await resolveOverlayTargetPoint(cdp, sid, targetArg, refMap, refState);
  const raw = await evalStr(cdp, sid, overlayDetectorScript({ targetPoint }));
  const model = JSON.parse(raw);
  if (model.blocking && !model.nextCommand) model.nextCommand = `cdp dismiss-modal ${targetId}`;
  if (fopts.format === 'json') return formatJson(model);
  return formatOverlayReport(model, targetId);
}

// ---------------------------------------------------------------------------
// dismiss-modal: close common dialog/modal patterns without firing background
// shortcuts. Reviewer feedback: pressing Space to close a "press any key" MOTD
// also triggered the underlying game's `space` shortcut. dismiss-modal favours
// safer signals (Escape / explicit close button / aria-modal click target)
// over global-key presses.
// ---------------------------------------------------------------------------

function dismissModalScript() {
  return `(function() {
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
      return true;
    }
    function findCloseButton(root) {
      const candidates = root.querySelectorAll('button, [role="button"], a, [aria-label], [data-dismiss], [data-close]');
      const labels = ['close', 'dismiss', 'cancel', 'ok', '關閉', '取消', '確認', '繼續', '×', '✕'];
      for (const el of candidates) {
        if (!visible(el)) continue;
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const txt  = (el.textContent || '').trim().toLowerCase();
        const data = (el.getAttribute('data-dismiss') || el.getAttribute('data-close') || '').toLowerCase();
        for (const lab of labels) {
          if (aria.includes(lab) || txt === lab || txt.includes(lab) || data.includes(lab)) {
            return { el, label: lab };
          }
        }
      }
      return null;
    }
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')).filter(visible);
    if (dialogs.length === 0) {
      return JSON.stringify({ ok: false, reason: 'no-dialog' });
    }
    // Prefer an explicit close button inside a visible dialog.
    for (const d of dialogs) {
      const hit = findCloseButton(d);
      if (hit) {
        hit.el.click();
        return JSON.stringify({ ok: true, action: 'click', label: hit.label, sel: d.tagName.toLowerCase() });
      }
    }
    // Fall through: signal that the caller should send Escape next.
    return JSON.stringify({ ok: false, reason: 'no-close-button', dialogs: dialogs.length });
  })()`;
}

async function dismissModalStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, dismissModalScript());
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { parsed = { ok: false, reason: 'parse-error' }; }
  if (parsed.ok) {
    return `Dismissed modal via close button "${parsed.label}" (${parsed.sel})`;
  }
  if (parsed.reason === 'no-dialog') {
    return 'No visible modal/dialog detected.';
  }
  // Fallback: send Escape (does not fire window-level shortcuts the way Space does).
  await pressStr(cdp, sid, 'escape');
  return `No close button found in ${parsed.dialogs || 0} dialog(s); sent Escape as fallback.`;
}

// ---------------------------------------------------------------------------
// Per-tab daemon
// ---------------------------------------------------------------------------

async function runDaemon(targetId) {
  resetScreenshotTier();
  const sp = sockPath(targetId);
  const daemonMetadata = collectDaemonMetadata();

  const cdp = new CDP();
  try {
    await cdp.connect(await getWsUrl());
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
    process.exit(1);
  }

  let sessionId;
  try {
    const res = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  const session = createSessionState({ targetId, sessionId });
  initializeSessionLog(session);
  ensureSessionScreenshotDir(session);

  // --- Background observation ---
  const consoleBuf = new RingBuffer(200);
  const exceptionBuf = new RingBuffer(50);
  const navBuf = new RingBuffer(10);
  const netReqBuf = new RingBuffer(100); // network request/response pairs
  const pendingReqs = session.pendingRequests; // requestId → {method, url, ts}
  const networkStatusByRequest = new Map(); // requestId → statusCode from ExtraInfo that arrived first
  let lastReadSeq = { console: 0, exception: 0 };

  // --- Ref system & perceive diff state ---
  const refMap = session.refs.map;              // ref number → backendDOMNodeId
  const lastPerceiveStore = session.lastPerceive; // stores last perceive output for diff
  const refState = session.refs;                // ref lifecycle for stale @ref errors
  session.buffers = {
    console: consoleBuf,
    exception: exceptionBuf,
    navigation: navBuf,
    network: netReqBuf,
  };

  // Enable domains for background collection and ref resolution
  try { await cdp.send('Runtime.enable', {}, sessionId); } catch {}
  try { await cdp.send('Page.enable', {}, sessionId); } catch {}
  try { await cdp.send('DOM.enable', {}, sessionId); } catch {}
  try { await cdp.send('CSS.enable', {}, sessionId); } catch {}
  try { await cdp.send('Network.enable', {}, sessionId); } catch {}

  cdp.onEvent('Runtime.consoleAPICalled', (params) => {
    const level = params.type || 'log';
    const text = (params.args || []).map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
    const stack = params.stackTrace?.callFrames?.[0];
    const file = stack?.url?.split('/').pop() || '';
    const loc = file && stack.lineNumber > 0 ? `${file}:${stack.lineNumber}` : '';
    consoleBuf.push({ level, text, loc, ts: Date.now() });
  });

  cdp.onEvent('Runtime.exceptionThrown', (params) => {
    const detail = params.exceptionDetails;
    // exception.description has full message (e.g. "Error: foo"); text is just "Uncaught"
    const msg = detail?.exception?.description || detail?.text || 'Unknown error';
    const stack = detail?.stackTrace?.callFrames?.[0];
    const file = stack?.url?.split('/').pop() || '';
    const loc = file && stack.lineNumber > 0 ? `${file}:${stack.lineNumber}` : '';
    exceptionBuf.push({ msg, loc, ts: Date.now() });
  });

  cdp.onEvent('Page.frameNavigated', (params) => {
    if (!params.frame.parentId) { // main frame only
      navBuf.push({ url: params.frame.url, ts: Date.now() });
      // Top-level navigation (or Vite HMR full reload) invalidates all @refs.
      session.pageGeneration += 1;
      invalidateSessionRefs(session, 'navigation');
    }
  });

  // --- Network request/response tracking ---
  function appendNetworkResponse(requestId, req, { status = null, type = req.type, size = 0, failed = false, errorText = null } = {}) {
    pendingReqs.delete(requestId);
    netReqBuf.push({
      method: req.method,
      url: req.url,
      status,
      type,
      duration: Date.now() - req.ts,
      size,
      ...(failed ? { failed: true } : {}),
      ...(errorText ? { errorText } : {}),
      ts: req.ts,
    });
  }

  cdp.onEvent('Network.requestWillBeSent', (params) => {
    // Track action-relevant traffic while skipping static asset noise.
    if (shouldTrackActionNetworkRequest(params.type)) {
      const req = {
        method: params.request.method,
        url: params.request.url.substring(0, 200),
        type: params.type,
        ts: Date.now(),
      };
      if (networkStatusByRequest.has(params.requestId)) {
        const status = networkStatusByRequest.get(params.requestId);
        networkStatusByRequest.delete(params.requestId);
        appendNetworkResponse(params.requestId, req, { status });
      } else {
        pendingReqs.set(params.requestId, req);
      }
    }
  });
  cdp.onEvent('Network.responseReceived', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!req) return;
    appendNetworkResponse(params.requestId, req, {
      status: params.response.status,
      type: params.type,
      size: params.response.encodedDataLength || 0,
    });
  });

  cdp.onEvent('Network.responseReceivedExtraInfo', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!Number.isFinite(Number(params.statusCode))) return;
    const status = Number(params.statusCode);
    if (!req) {
      networkStatusByRequest.set(params.requestId, status);
      return;
    }
    appendNetworkResponse(params.requestId, req, { status });
  });

  cdp.onEvent('Network.loadingFinished', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!req) return;
    appendNetworkResponse(params.requestId, req, {
      status: null,
      size: params.encodedDataLength || 0,
    });
  });

  cdp.onEvent('Network.loadingFailed', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!req) return;
    appendNetworkResponse(params.requestId, req, {
      status: null,
      type: params.type,
      failed: true,
      errorText: params.errorText || 'loadingFailed',
    });
  });

  cdp.onEvent('Fetch.requestPaused', (params) => {
    handleMockRequestPaused(cdp, sessionId, session, params).catch(() => {
      cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
    });
  });

  // --- Dialog handling (alert/confirm/prompt/beforeunload) ---
  const dialogBuf = new RingBuffer(20);
  session.buffers.dialog = dialogBuf;
  const dialogAutoAcceptRef = { value: true }; // auto-dismiss by default to prevent page lockups
  cdp.onEvent('Page.javascriptDialogOpening', (params) => {
    dialogBuf.push({ type: params.type, message: params.message, ts: Date.now() });
    cdp.send('Page.handleJavaScriptDialog', {
      accept: dialogAutoAcceptRef.value,
      promptText: dialogAutoAcceptRef.value ? params.defaultPrompt || '' : undefined,
    }, sessionId).catch(() => {});
  });

  // Shutdown helpers
  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    cdp.close();
    process.exit(0);
  }

  // Exit if target goes away or Chrome disconnects
  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Idle timer
  let keepaliveUntil = 0;
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function scheduleIdle() {
    clearTimeout(idleTimer);
    const delay = Math.max(IDLE_TIMEOUT, keepaliveUntil - Date.now(), 1000);
    idleTimer = setTimeout(shutdown, delay);
  }
  function resetIdle() {
    scheduleIdle();
  }
  function extendKeepalive(ms) {
    keepaliveUntil = Math.max(keepaliveUntil, Date.now() + ms);
    scheduleIdle();
    return `Daemon keepalive extended for ${ms}ms (until ${new Date(keepaliveUntil).toISOString()})`;
  }

  // Action feedback: wait for DOM to settle, then return structured evidence.
  const BATCH_BLOCKED = new Set(['batch', 'stop', 'repeat', 'flow']);
  async function observeActionDiffForTarget(target = {}, baselineOutput = null) {
    const targetFrameRef = frameRefFromActionTarget(target);
    await waitForSettle(cdp, sessionId);
    return perceiveStr(
      cdp,
      sessionId,
      consoleBuf,
      exceptionBuf,
      refMap,
      lastPerceiveStore,
      targetFrameRef
        ? { sinceAction: true, diffBaseline: baselineOutput, frameRef: targetFrameRef }
        : { sinceAction: true, diffBaseline: baselineOutput },
      refState
    );
  }
  async function observeFullPerceive() {
    await waitForSettle(cdp, sessionId);
    return perceiveStr(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, {}, refState);
  }
  async function actionFeedback(action, actionDispatch, target = {}, feedbackPolicy = 'settle-diff', observe = null, format = 'text', captureActionResult = null) {
    const dispatch = typeof actionDispatch === 'function' ? actionDispatch : async () => actionDispatch;
    const actionTarget = target && typeof target === 'object'
      ? { ...target, targetId }
      : { input: String(target || ''), label: String(target || ''), targetId };
    const baselineOutput = baselineOutputForActionTarget(refState, lastPerceiveStore.output, actionTarget);
    const observationBaseline = createActionObservationBaseline({ consoleBuf, exceptionBuf, netReqBuf });
    const actionStartedAt = Date.now();
    const observeAfterAction = observe || (() => observeActionDiffForTarget(actionTarget, baselineOutput));
    const observeThenFlush = async () => {
      const text = await observeAfterAction();
      await waitForActionNetworkQuiet(pendingReqs);
      appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
      return text;
    };
    session.lastAction = { action, target: actionTarget, feedbackPolicy, ts: actionStartedAt, baselineOutput };
    return runActionWithFeedback({
      action,
      target: actionTarget,
      dispatch,
      feedbackPolicy,
      observe: observeThenFlush,
      enrichActionResult: (actionResult) => applyActionObservationDelta(actionResult, buildActionObservationDelta(
        { consoleBuf, exceptionBuf, netReqBuf },
        observationBaseline
      )),
      onActionResult: (actionResult) => {
        appendSessionActionLog(session, actionResult, { ts: session.lastAction.ts });
        captureActionResult?.(actionResult);
      },
      format,
    });
  }

  // Handle a command
  async function handleCommand({ cmd, args }) {
    resetIdle();
    try {
      let result;
      switch (cmd) {
        case 'meta': {
          result = formatJson(daemonMetadata);
          break;
        }
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages, _browserInfo);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case 'snap': case 'snapshot': result = await snapshotStr(cdp, sessionId, args[0] !== '--full'); break;
        case 'eval': {
          const eopts = parseEvalArgs(args);
          if (eopts.fireAndForget) {
            result = await evalFireAndForgetStr(cdp, sessionId, eopts.expression, true);
            result += `\n${extendKeepalive(FIRE_AND_FORGET_KEEPALIVE)} (fire-and-forget default)`;
          } else {
            result = await evalStr(cdp, sessionId, eopts.expression, true, { raw: eopts.raw });
          }
          break;
        }
        case 'eval64': {
          const decoded = evalBase64Decode(args[0]);
          result = await evalStr(cdp, sessionId, decoded, true);
          break;
        }
        case 'call': result = await callStr(cdp, sessionId, args.join(' ')); break;
        case 'wait': result = await waitStr(args[0]); break;
        case 'keepalive': result = extendKeepalive(parseDelayMs(args[0], { name: 'keepalive duration' })); break;
        case 'shot': case 'screenshot': {
          if (args[0] === '--annotate' || args[0] === '-a') {
            result = await annotshotStr(cdp, sessionId, targetId, refMap);
            appendSessionScreenshot(session, {
              kind: 'annotshot',
              path: result.split('\n')[0],
              note: 'annotated refs',
            });
          } else {
            const sopts = parseShotArgs(args);
            const filePath = sopts.filePath || nextSessionScreenshotPath(session, 'shot');
            if (!sopts.filePath) ensureSessionScreenshotDir(session);
            result = await shotStr(cdp, sessionId, filePath, targetId, { quiet: sopts.quiet, verbose: sopts.verbose });
            appendSessionScreenshot(session, {
              kind: 'shot',
              path: result.split('\n')[0],
              note: sopts.filePath ? 'custom path' : 'session screenshot',
            });
          }
          break;
        }
        case 'diff-shot': case 'diffshot': {
          result = await diffShotStr(cdp, sessionId, session, parseDiffShotArgs(args));
          break;
        }
        case 'html': result = await htmlStr(cdp, sessionId, args); break;
        case 'nav': case 'navigate': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback(
            'nav',
            () => navStr(cdp, sessionId, fopts.args[0]),
            { input: fopts.args[0], resolvedBy: 'url', label: fopts.args[0] || '', commandArgs: [fopts.args[0]] },
            'full-perceive',
            observeFullPerceive,
            fopts
          );
          break;
        }
        case 'net': case 'network': result = await netStr(cdp, sessionId); break;
        case 'mock': case 'network-mock': result = await mockStr(cdp, sessionId, session, args); break;
        case 'clock': case 'time-travel': result = await clockStr(cdp, sessionId, session, args); break;
        case 'throttle': case 'network-throttle': result = await throttleStr(cdp, sessionId, session, args); break;
        case 'status': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          if (fopts.format === 'json') {
            const runtime = fopts.args.includes('--runtime')
              ? await runtimeMetricsStr(cdp, sessionId).catch(e => ({ unavailable: e.message }))
              : null;
            const page = await pageInfoModel(cdp, sessionId, { targetPrefix: targetPrefixForDisplay(targetId) });
            result = formatJson(buildStatusModel({
              targetId,
              page: { title: page.title, url: page.url },
              consoleBuf,
              exceptionBuf,
              navBuf,
              lastReadSeq,
              runtime,
              diagnostic: page.diagnostic || null,
            }));
            lastReadSeq.console = consoleBuf.latest();
            lastReadSeq.exception = exceptionBuf.latest();
          } else {
            result = await statusStr(cdp, sessionId, consoleBuf, exceptionBuf, navBuf, lastReadSeq, { runtime: fopts.args.includes('--runtime'), targetPrefix: targetPrefixForDisplay(targetId) });
          }
          break;
        }
        case 'console': {
          const opts = parseConsoleArgs(args);
          if (opts.mode === 'clear') {
            const model = clearConsoleBaseline(consoleBuf, exceptionBuf, lastReadSeq);
            result = opts.format === 'json' ? formatJson(model) : model.message;
          } else if (opts.format === 'json') {
            result = formatJson(buildConsoleModel(consoleBuf, exceptionBuf, lastReadSeq, opts.mode));
            if (opts.mode === 'new') {
              lastReadSeq.console = consoleBuf.latest();
              lastReadSeq.exception = exceptionBuf.latest();
            }
          } else {
            result = await consoleStr(consoleBuf, exceptionBuf, lastReadSeq, opts.mode);
          }
          break;
        }
        case 'summary': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          result = fopts.format === 'json'
            ? formatJson(await summaryModel(cdp, sessionId, consoleBuf, exceptionBuf))
            : await summaryStr(cdp, sessionId, consoleBuf, exceptionBuf);
          break;
        }
        case 'frame': case 'frames': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          result = await framesStr(cdp, sessionId, { format: fopts.format });
          break;
        }
        case 'overlay': case 'overlays': {
          result = await overlayStr(cdp, sessionId, targetId, args, refMap, refState);
          break;
        }
        case 'report': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          const ropts = parseReportArgs(fopts.args);
          if (ropts.args.length) throw new Error(`report: unknown argument ${ropts.args[0]}`);
          result = formatSessionReport(session, {
            format: fopts.format,
            lastActions: ropts.lastActions,
            compact: ropts.compact,
            qa: ropts.qa,
          });
          break;
        }
        case 'responsive-audit': case 'visual-check': {
          result = await responsiveAuditStr(cdp, sessionId, session, targetId, consoleBuf, exceptionBuf, args);
          break;
        }
        case 'qa': case 'qa-page': {
          const qopts = parseQaArgs(args);
          const errors = [];
          const page = await pageInfoModel(cdp, sessionId, { targetPrefix: targetPrefixForDisplay(targetId) });
          const consoleHealth = {
            errors: consoleBuf.all().filter(entry => entry.level === 'error').length,
            warnings: consoleBuf.all().filter(entry => entry.level === 'warning' || entry.level === 'warn').length,
            exceptions: exceptionBuf.all().length,
          };
          const screenshots = {};
          for (const [kind, size] of [['desktop', qopts.desktop], ['mobile', qopts.mobile]]) {
            if (!size) continue;
            try {
              await viewportStr(cdp, sessionId, size);
              ensureSessionScreenshotDir(session);
              const path = nextSessionScreenshotPath(session, kind);
              const shot = await shotStr(cdp, sessionId, path, targetId, { quiet: true });
              appendSessionScreenshot(session, { kind: `qa-${kind}`, path: shot.split('\n')[0], note: size });
              screenshots[kind] = { viewport: size, path: shot.split('\n')[0] };
            } catch (e) {
              errors.push(`${kind} screenshot: ${e.message}`);
            }
          }
          let perception = null;
          try {
            const text = await perceiveStr(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, { cursorInteractive: true, maxDepth: 4, targetPrefix: targetPrefixForDisplay(targetId) }, refState);
            perception = { captured: true, summary: text.split('\n').slice(0, 6).join('\n') };
          } catch (e) {
            perception = { captured: false, error: e.message };
            errors.push(`perceive: ${e.message}`);
          }
          let action = null;
          const assertions = [];
          if (qopts.click) {
            let captured = null;
            await actionFeedback(
              'click',
              () => clickStr(cdp, sessionId, qopts.click, refMap, refState),
              { input: qopts.click, resolvedBy: 'selector-or-ref', label: qopts.click || '', commandArgs: [qopts.click] },
              'settle-diff',
              null,
              'json',
              result => { captured = result; }
            );
            const textMatched = qopts.expectText ? await pageContainsText(cdp, sessionId, qopts.expectText).catch(() => false) : false;
            action = buildSemanticInteractionModel(captured || {}, {
              selector: qopts.click,
              expectRequest: qopts.expectRequest,
              expectStatus: qopts.expectStatus,
              expectText: qopts.expectText,
              noConsoleErrors: qopts.noConsoleErrors,
              evidence: 'concise',
            }, { textMatched });
          } else {
            if (qopts.expectText) {
              const textMatched = await pageContainsText(cdp, sessionId, qopts.expectText).catch(() => false);
              assertions.push({
                kind: 'text',
                expected: qopts.expectText,
                status: textMatched ? 'pass' : 'fail',
                message: textMatched ? `"${qopts.expectText}" matched` : `"${qopts.expectText}" not found`,
              });
            }
            if (qopts.expectRequest) {
              assertions.push({
                kind: 'request',
                expected: qopts.expectRequest,
                status: 'fail',
                message: '--expect-request requires --click so the command can collect action network evidence',
              });
            }
          }
          const model = buildQaPageModel({
            targetId,
            page: { title: page.title, url: page.url },
            console: consoleHealth,
            perception,
            screenshots,
            action,
            assertions,
            errors,
          });
          result = qopts.format === 'json' ? formatJson(model) : formatQaPageReport(model);
          break;
        }
        case 'checkpoint': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          const copts = parseCheckpointArgs(fopts.args);
          if (copts.args.length) throw new Error(`checkpoint: unknown argument ${copts.args[0]}`);
          result = await checkpointStr(cdp, sessionId, { format: fopts.format, unsafeFullCapture: copts.unsafeFullCapture });
          appendSessionEventLog(session, { kind: 'checkpoint', url: result.includes('URL: ') ? result.split('URL: ')[1]?.split('\n')[0] : undefined });
          break;
        }
        case 'record-actions': case 'recordactions': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          result = formatRecordActions(session, { format: fopts.format });
          break;
        }
        case 'export-playwright': case 'export-pw': {
          result = formatExportPlaywright(session, parseExportPlaywrightArgs(args));
          break;
        }
        case 'perceive': {
          const fopts = parseQaModeArgs(args, ['text', 'json']);
          const popts = parsePerceiveArgs(fopts.args);
          popts.targetPrefix = targetPrefixForDisplay(targetId);
          if (popts.sinceAction) {
            popts.diffBaseline = session.lastAction?.baselineOutput || null;
          }
          if (fopts.qa) {
            const page = await pageInfoModel(cdp, sessionId, { targetPrefix: targetPrefixForDisplay(targetId) });
            const consoleHealth = {
              errors: consoleBuf.all().filter(entry => entry.level === 'error').length,
              warnings: consoleBuf.all().filter(entry => entry.level === 'warning' || entry.level === 'warn').length,
              exceptions: exceptionBuf.all().length,
            };
            let text = '';
            try {
              text = await perceiveStr(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, {
                ...popts,
                interactive: true,
                maxDepth: Math.min(popts.maxDepth || 8, 6),
              }, refState);
            } catch (e) {
              text = e.message || String(e);
            }
            const summary = buildQaSummaryModel({
              page: { title: page.title, url: page.url },
              console: consoleHealth,
              network: { failures: countNetworkFailures(netReqBuf) },
              blank: isBlankPageUrl(page.url),
              targetPrefix: targetPrefixForDisplay(targetId),
              nextCommand: `cdp report ${targetPrefixForDisplay(targetId)}`,
              source: 'perceive',
            });
            if (fopts.format === 'json') {
              result = formatJson({
                summary,
                perceptionPreview: truncateTextLines(text, fopts.maxDiffLines ?? 20),
              });
            } else {
              result = formatQaSummaryText(summary);
            }
            break;
          }
          result = fopts.format === 'json' && (popts.sinceAction || popts.diff)
            ? formatJson(await perceiveDiffModel(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState))
            : fopts.format === 'json'
            ? formatPerceptionJson(await perceiveModel(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState))
            : await perceiveStr(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState);
          if (fopts.maxDiffLines != null && fopts.format !== 'json') {
            result = truncateTextLines(result, fopts.maxDiffLines);
          }
          break;
        }
        case 'controls': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          const copts = parseControlsArgs(fopts.args);
          result = await controlsStr(cdp, sessionId, { ...copts, format: fopts.format });
          break;
        }
        case 'elshot': result = await elshotStr(cdp, sessionId, args[0], targetId, refMap, refState); break;
        case 'verify-click': case 'verifyclick': {
          const vopts = parseVerifyClickArgs(args);
          let captured = null;
          await actionFeedback(
            'click',
            () => clickStr(cdp, sessionId, vopts.selector, refMap, refState),
            { input: vopts.selector, resolvedBy: 'selector-or-ref', label: vopts.selector || '', commandArgs: [vopts.selector] },
            'settle-diff',
            null,
            'json',
            result => { captured = result; }
          );
          const textMatched = vopts.expectText ? await pageContainsText(cdp, sessionId, vopts.expectText).catch(() => false) : false;
          const model = buildSemanticInteractionModel(captured || {}, vopts, { textMatched });
          result = vopts.format === 'json'
            ? formatJson(model)
            : `${formatSemanticInteractionResult(model)}${vopts.evidence === 'full' && captured ? `\n---\n${formatActionText(captured)}` : ''}`;
          break;
        }
        case 'click': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          const cargs = fopts.args;
          // `click --js <selector|@ref>` switches to the JS-fallback path that
          // calls HTMLElement.click() instead of dispatching CDP mouse events.
          // Useful when overlays or weird hit testing block the realistic
          // mouse path; opt-in only so default behaviour is unchanged.
          if (cargs[0] === '--js' || cargs[0] === '-j') {
            result = await actionFeedback('click', () => jsClickStr(cdp, sessionId, cargs[1], refMap, refState), { input: cargs[1], resolvedBy: 'selector-or-ref', label: cargs[1] || '', commandArgs: ['--js', cargs[1]] }, 'settle-diff', null, fopts);
          } else {
            result = await actionFeedback('click', () => clickStr(cdp, sessionId, cargs[0], refMap, refState), { input: cargs[0], resolvedBy: 'selector-or-ref', label: cargs[0] || '', commandArgs: [cargs[0]] }, 'settle-diff', null, fopts);
          }
          break;
        }
        case 'jsclick': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback('jsclick', () => jsClickStr(cdp, sessionId, fopts.args[0], refMap, refState), { input: fopts.args[0], resolvedBy: 'selector-or-ref', label: fopts.args[0] || '', commandArgs: [fopts.args[0]] }, 'settle-diff', null, fopts);
          break;
        }
        case 'clickxy': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback('clickxy', () => clickXyStr(cdp, sessionId, fopts.args[0], fopts.args[1]), { input: `${fopts.args[0]},${fopts.args[1]}`, resolvedBy: 'coordinates', label: `${fopts.args[0]},${fopts.args[1]}`, commandArgs: [fopts.args[0], fopts.args[1]] }, 'settle-diff', null, fopts);
          break;
        }
        case 'type': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback('type', () => typeStr(cdp, sessionId, fopts.args[0]), { input: 'current focus', resolvedBy: 'focus', label: 'current focus', commandArgs: [fopts.args[0]] }, 'settle-diff', null, fopts);
          break;
        }
        case 'press': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback('press', () => pressStr(cdp, sessionId, fopts.args[0]), { input: fopts.args[0], resolvedBy: 'key', label: fopts.args[0] || '', commandArgs: [fopts.args[0]] }, 'settle-diff', null, fopts);
          break;
        }
        case 'scroll': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback('scroll', () => scrollStr(cdp, sessionId, fopts.args[0], fopts.args[1]), { input: [fopts.args[0], fopts.args[1]].filter(Boolean).join(' '), resolvedBy: 'scroll', label: fopts.args[0] || 'scroll', commandArgs: [fopts.args[0], fopts.args[1]] }, 'settle-diff', null, fopts);
          break;
        }
        case 'hover': result = await hoverStr(cdp, sessionId, args[0], refMap, refState); break;
        case 'waitfor': result = await waitForStr(cdp, sessionId, args, refMap, refState); break;
        case 'loadall': result = await loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 1500); break;
        case 'fill': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          const fargs = fopts.args;
          if (fargs[0] === '--react') result = await actionFeedback('fill', () => fillStr(cdp, sessionId, fargs[1], fargs[2], refMap, refState, { react: true }), { input: fargs[1], resolvedBy: 'selector-or-ref', label: fargs[1] || '', commandArgs: ['--react', fargs[1], fargs[2]] }, 'settle-diff', null, fopts);
          else result = await actionFeedback('fill', () => fillStr(cdp, sessionId, fargs[0], fargs[1], refMap, refState), { input: fargs[0], resolvedBy: 'selector-or-ref', label: fargs[0] || '', commandArgs: [fargs[0], fargs[1]] }, 'settle-diff', null, fopts);
          break;
        }
        case 'select': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback('select', () => selectStr(cdp, sessionId, fopts.args[0], fopts.args[1]), { input: fopts.args[0], resolvedBy: 'selector', label: fopts.args[0] || '', commandArgs: [fopts.args[0], fopts.args[1]] }, 'settle-diff', null, fopts);
          break;
        }
        case 'fullshot': result = await fullshotStr(cdp, sessionId, args[0], targetId); break;
        case 'scanshot': result = await scanshotStr(cdp, sessionId, targetId); break;
        case 'styles': result = await stylesStr(cdp, sessionId, args); break;
        case 'components': result = await componentsStr(cdp, sessionId, args, refMap, refState); break;
        case 'cookies': result = await cookiesStr(cdp, sessionId); break;
        case 'cookieset': result = await cookieSetStr(cdp, sessionId, args[0]); break;
        case 'cookiedel': result = await cookieDelStr(cdp, sessionId, args[0]); break;
        case 'dialog': result = dialogStr(dialogBuf, dialogAutoAcceptRef, args[0]); break;
        case 'viewport': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          if (fopts.args[0]) result = await actionFeedback('viewport', () => viewportStr(cdp, sessionId, fopts.args[0]), { input: fopts.args[0], resolvedBy: 'viewport', label: fopts.args[0], commandArgs: [fopts.args[0]] }, 'settle-diff', null, fopts); // auto-diff when resizing
          else result = await viewportStr(cdp, sessionId, args[0]);
          break;
        }
        case 'emulate': {
          result = await emulateStr(cdp, sessionId, session, args, { targetPrefix: targetPrefixForDisplay(targetId) });
          break;
        }
        case 'upload': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback('upload', () => uploadStr(cdp, sessionId, fopts.args[0], fopts.args[1]), { input: fopts.args[0], resolvedBy: 'selector', label: fopts.args[0] || '', commandArgs: [fopts.args[0], fopts.args[1]] }, 'state-change', null, fopts);
          break;
        }
        case 'text': result = await textStr(cdp, sessionId, args); break;
        case 'table': result = await tableStr(cdp, sessionId, args[0]); break;
        case 'back': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback('back', () => historyNavStr(cdp, sessionId, -1), { input: 'back', resolvedBy: 'history', label: 'back', commandArgs: [] }, 'full-perceive', observeFullPerceive, fopts);
          break;
        }
        case 'forward': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback('forward', () => historyNavStr(cdp, sessionId, +1), { input: 'forward', resolvedBy: 'history', label: 'forward', commandArgs: [] }, 'full-perceive', observeFullPerceive, fopts);
          break;
        }
        case 'reload': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback('reload', () => reloadActionDispatch({
            cdp,
            sessionId,
            session,
            consoleBuf,
            exceptionBuf,
            navBuf,
            netReqBuf,
            pendingReqs,
            lastReadSeq,
          }), { input: 'reload', resolvedBy: 'page', label: 'reload', commandArgs: [] }, 'state-change', () => observeReloadPage(cdp, sessionId), fopts);
          break;
        }
        case 'closetab': result = await closetabStr(cdp, targetId); break;
        case 'netlog': result = netlogStr(netReqBuf, args[0]); break;
        case 'inject': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback('inject', () => injectStr(cdp, sessionId, fopts.args), { input: fopts.args[0] || '', resolvedBy: 'command', label: fopts.args[0] || 'inject', commandArgs: fopts.args }, 'state-change', null, fopts);
          break;
        }
        case 'record': result = await recordStr(cdp, sessionId, args, refMap); break;
        case 'cascade': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          result = await cascadeStr(cdp, sessionId, fopts.args[0], fopts.args[1], refMap, refState, { format: fopts.format });
          break;
        }
        case 'dismiss-modal': case 'dismissmodal': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          result = await actionFeedback('dismiss-modal', () => dismissModalStr(cdp, sessionId), { input: 'modal', resolvedBy: 'dialog', label: 'modal', commandArgs: [] }, 'settle-diff', null, fopts);
          break;
        }
        case 'evalraw': result = await evalRawStr(cdp, sessionId, args[0], args[1]); break;
        case 'batch': {
          let parsedBatch;
          try {
            parsedBatch = parseBatchArgs(args);
          } catch (e) {
            return { ok: false, error: e.message };
          }
          const { commands, parallel } = parsedBatch;
          if (!commands.length) return { ok: false, error: 'batch: no commands provided' };
          const blocked = commands.filter(c => BATCH_BLOCKED.has(c.cmd));
          if (blocked.length) return { ok: false, error: `batch: ${blocked.map(c => c.cmd).join(', ')} not allowed inside batch` };
          if (parallel) {
            const unsafe = commands.filter(c => isBatchParallelUnsafeCommand(c.cmd));
            if (unsafe.length) return { ok: false, error: `batch --parallel: ${[...new Set(unsafe.map(c => c.cmd))].join(', ')} mutate shared state — use sequential batch` };
          }
          const autoActionJson = parsedBatch.output === 'model';
          const runOne = async (c) => {
            const sub = await handleCommand({ cmd: c.cmd, args: autoActionJsonArgs(c.cmd, c.args || [], autoActionJson) });
            return { cmd: c.cmd, ok: sub.ok, result: sub.result, error: sub.error };
          };
          let results;
          if (parallel) {
            results = await Promise.all(commands.map(runOne));
          } else {
            results = [];
            for (const c of commands) results.push(await runOne(c));
          }
          const fmt = parsedBatch.output === 'legacy-json' ? 'json' : parsedBatch.output;
          result = formatBatchResults(results, fmt, { targetId, mode: parallel ? 'parallel' : 'sequential' });
          break;
        }
        case 'flow': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          const input = fopts.args.join(' ');
          result = await flowStr({
            run: (step) => handleCommand({ cmd: step.cmd, args: autoActionJsonArgs(step.cmd, step.args || [], fopts.format === 'json') }),
            settle: (what) => settleFlow(cdp, sessionId, what, pendingReqs),
            assertCondition: (condition) => probePageCondition(cdp, sessionId, condition),
          }, input, { format: fopts.format, targetId });
          break;
        }
        case 'repeat': {
          result = await repeatStr({
            run: (step) => handleCommand({ cmd: step.cmd, args: step.args || [] }),
            probeCondition: (condition) => probePageCondition(cdp, sessionId, condition),
          }, args);
          break;
        }
        case 'replay': {
          result = await replayActionsStr({
            run: (step) => handleCommand({ cmd: step.cmd, args: step.args || [] }),
          }, args);
          break;
        }
        case 'restore': {
          const fopts = parseCompactFormatArgs(args, ['text', 'json']);
          const safeCommandArgs = redactRestoreCommandArgs(fopts.args);
          result = await actionFeedback(
            'restore',
            async () => {
              const restoreResult = await restoreCheckpointStr(cdp, sessionId, fopts.args);
              clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq });
              session.pageGeneration += 1;
              invalidateSessionRefs(session, 'navigation');
              return restoreResult;
            },
            { input: 'checkpoint', resolvedBy: 'artifact', label: 'checkpoint', commandArgs: safeCommandArgs },
            'report-only',
            null,
            fopts
          );
          break;
        }
        case 'stop': return { ok: true, result: '', stopAfter: true };
        default: return { ok: false, error: `Unknown command: ${cmd}` };
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      const rawError = actionFailureMessage(e);
      const commandMeta = COMMANDS.find(command => command.name === cmd || (command.aliases || []).includes(cmd));
      const isMutatingCommand = commandMeta?.mutates === true;
      const alreadyClassified = rawError.startsWith('Action failure:');
      const lastAction = session.lastAction || {};
      const context = {
        action: isMutatingCommand && lastAction.action ? lastAction.action : cmd,
        target: isMutatingCommand && lastAction.target ? lastAction.target : { targetId, input: args?.[0], label: args?.[0] },
      };
      const failure = classifyActionFailure(e, context);
      const error = alreadyClassified || (isMutatingCommand && failure.kind !== 'unknown')
        ? formatActionFailure(e, context)
        : rawError;
      return { ok: false, error };
    }
  }

  // Unix socket server — NDJSON protocol
  // Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
  // Request:  { "id": <number>, "cmd": "<command>", "args": ["arg1", "arg2", ...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  //           or { "id": <number>, "ok": false, "error": "<message>" }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        handleCommand(req).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  server.on('error', (e) => {
    process.stderr.write(`Daemon server listen failed: ${e.message}\n`);
    process.exit(1);
  });

  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
  server.listen(sp);
}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const conn = net.connect(sp);
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.off('connect', onConnect);
      conn.off('error', onError);
      fn();
    };
    const onConnect = () => settle(() => resolve(conn));
    const onError = (error) => settle(() => reject(error));
    const timer = setTimeout(() => {
      settle(() => {
        conn.destroy();
        reject(new Error(`Timed out connecting to daemon socket: ${sp}`));
      });
    }, timeoutMs);
    conn.on('connect', onConnect);
    conn.on('error', onError);
  });
}

async function getOrStartTabDaemon(targetId, opts = {}) {
  const sp = sockPath(targetId);
  // Try existing daemon
  try { return await connectToSocket(sp); } catch {}

  // Clean stale socket
  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}

  // Spawn daemon
  const child = spawn(process.execPath, [process.argv[1], '_daemon', targetId], {
    detached: true,
    stdio: 'ignore',
    env: opts.env || process.env,
  });
  child.unref();

  // Wait for socket (includes time for user to click Allow)
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try { return await connectToSocket(sp); } catch {}
  }
  throw new Error('Daemon failed to start — did you click Allow in Chrome?');
}

const IPC_TIMEOUT = 120000; // 2 minutes — generous for slow commands like scanshot

function ipcTimeoutForRequest(req) {
  if (Number.isFinite(req?.timeoutMs) && req.timeoutMs > 0) {
    return Math.min(Math.max(100, Math.trunc(req.timeoutMs)), IPC_TIMEOUT);
  }
  if (req?.cmd !== 'wait') return IPC_TIMEOUT;
  try {
    const waitMs = parseDelayMs(req.args?.[0], { name: 'wait duration', max: 60 * 60 * 1000 });
    return Math.max(IPC_TIMEOUT, waitMs + 5000);
  } catch {
    return IPC_TIMEOUT;
  }
}

function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;

    const settle = (fn) => { if (settled) return; settled = true; cleanup(); clearTimeout(timer); fn(); };

    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };

    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settle(() => { resolve(JSON.parse(buf.slice(0, idx))); conn.end(); });
    };

    const onError = (error) => settle(() => reject(error));
    const onEnd = () => settle(() => reject(new Error(`Connection closed before response. The daemon for this tab may have crashed or exited (idle timeout, page closed, or browser disconnect). Re-run "perceive <target>" to restart it; check ${RUNTIME_DIR} for stale sockets if this repeats.`)));
    const onClose = () => settle(() => reject(new Error(`Connection closed before response. The daemon for this tab may have crashed or exited (idle timeout, page closed, or browser disconnect). Re-run "perceive <target>" to restart it; check ${RUNTIME_DIR} for stale sockets if this repeats.`)));

    const timeoutMs = ipcTimeoutForRequest(req);
    const timer = setTimeout(() => {
      settle(() => { conn.destroy(); reject(new Error(`IPC timeout: command "${req.cmd}" took longer than ${timeoutMs / 1000}s`)); });
    }, timeoutMs);

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

async function assertFreshDaemonConnection(conn, { targetPrefix, currentMetadata }) {
  const response = await sendCommand(conn, { cmd: 'meta', args: [] });
  const daemonMetadata = response?.ok ? parseDaemonMetadataResult(response.result) : null;
  const assessment = assessDaemonFreshness({
    targetPrefix,
    current: currentMetadata,
    daemon: daemonMetadata,
  });
  if (assessment.stale) throw new Error(formatStaleDaemonMessage(assessment));
  return assessment;
}

// Find any running daemon socket to reuse for list
function findAnyDaemonSocket() {
  return listDaemonSockets()[0]?.socketPath || null;
}

// ---------------------------------------------------------------------------
// Stop daemons
// ---------------------------------------------------------------------------

async function stopDaemons(targetPrefix) {
  const daemons = listDaemonSockets();

  if (targetPrefix) {
    const targetId = resolvePrefix(targetPrefix, daemons.map(d => d.targetId), 'daemon');
    const daemon = daemons.find(d => d.targetId === targetId);
    try {
      const conn = await connectToSocket(daemon.socketPath);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      if (!IS_WINDOWS) try { unlinkSync(daemon.socketPath); } catch {}
    }
    return;
  }

  for (const daemon of daemons) {
    try {
      const conn = await connectToSocket(daemon.socketPath);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      if (!IS_WINDOWS) try { unlinkSync(daemon.socketPath); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp <command> [args]

  help                              Show this command reference (same as --help)
  list [--format json]              List open pages (shows unique target prefixes)
                                    JSON includes schema/pages/recommendation/nextSteps for agents.
                                    Prefers non-blank pages when recommending the next target (* marker).
  target --url URL|--title TEXT [--exact] [--format json]
                                    Select a page target by URL/title substring (or exact match).
                                    Ambiguous matches return candidate URLs/titles and follow-up commands.
  tab-group list|create|add|remove|delete|show [--format json]
                                    Named multi-tab groups stored outside the repo (runtime dir).
                                    create <name> [targets...] | add/remove <name> <target> | show/delete <name>
  broadcast <group> <cmd> [args...] [--format json] [--full-results]
                                    Run one command against every member of a tab-group.
                                    JSON bounds per-target previews; --full-results opts into complete payloads.
  use <target> --name <alias>        Save a named target alias (also becomes current)
                                    Accepts 9222/<target> to bind a CDP port to the alias.
  attach --port N --target <id> --name <alias>  Explicitly save an alias with host/port metadata
  current [--format json]            Show current alias plus saved aliases
  forget <alias>                     Remove a saved alias
  perceive <target> [flags] [--format json]  Full page perception with @ref indices + coordinates
                                    --diff: show only changes since last perceive
                                    --since-action: show changes caused by the last mutating command
                                    --qa / --summary: compact QA summary (url/title/blank/console/next)
                                    --max-diff-lines N: truncate long text output
                                    --adaptive / --last auto: density+error aware text-row budget
                                    --last N: keep last N text rows (explicit wins over adaptive)
                                    JSON includes structured refs plus recommendation/nextSteps.
                                    JSON with --diff/--since-action returns chrome-cdp-ex.perceive-diff.v1
                                    --frame @fN / -F @fN: perceive inside an iframe; refs become @fN:M
                                    -s <sel> / --selector: scope to CSS selector subtree
                                    -i / --interactive: only show interactive elements
                                    -d N / --depth N: limit tree depth
                                    -C / --cursor-interactive: include non-ARIA clickable elements (@c refs)
  snap  <target> [--full]           Accessibility tree snapshot (compact by default, --full for complete)
  controls <target> [-s selector] [--filter text] [--limit N] [--compact] [--format json]
                                    Bounded visible controls inventory for selector/debugging repair
  eval  <target> <expr>             Evaluate JS expression
                                    --b64 / -b <base64>: decode UTF-8 base64 first
                                    (safe transport for CJK / shell-hostile expressions)
                                    --raw: compact JSON for objects (skip pretty multi-line stringify)
                                    --fire-and-forget: dispatch without awaiting returned promise
  eval64 <target> <base64>          Shorthand for eval --b64; preserves multibyte characters
  call  <target> <expr|fn>          Await expression/function result and print JSON when possible
  elshot <target> <sel|@ref>        Element screenshot: captures element by CSS selector or @ref
  shot  <target> [file|--annotate]  Viewport screenshot; --annotate (-a) overlays @ref labels
  diff-shot <target> [--reset] [--threshold pct]  Compare current screenshot against last diff-shot baseline
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url> [--format json]  Navigate to URL and wait for load completion
  mock  <target> [add|clear]        Mock matching network requests in this live tab
                                    add <urlPattern> --status code --body text [--content-type type]
  clock <target> [freeze|offset|reset]  Override Date/time in this live tab
                                    freeze --at date-or-epoch-ms | offset --ms delta
  throttle <target> [off|offline|slow-3g|fast-3g|lte|custom]  Emulate network conditions for this tab
                                    custom --latency ms --download kbps --upload kbps
  status <target> [--runtime]        Page state + new console/exception entries (primary debug entry point)
                                    --runtime: include Performance.getMetrics counters
  console <target> [--all|--errors] Console buffer (default: new entries only; --all: last 200; --errors: errors+exceptions)
  summary <target>                  Token-efficient page overview (interactive elements, scroll, console health)
  report <target> [--last N|--all] [--format json] [--qa|--summary] [--compact]
                                    Session action timeline + evidence summary + JSONL log path
                                    --qa/--summary returns a compact chrome-cdp-ex.qa-summary.v1 handoff
  checkpoint <target> [--unsafe-full] [--format json]  Capture URL plus redacted cookies/storage; unsafe-full keeps restorable secrets
  restore <target> --file <path> [--format json]  Restore a checkpoint artifact into the live page
  restore <target> --json <json> [--format json]  Restore an inline checkpoint JSON artifact
  record-actions <target>           Export action log + mock/clock/throttle environment as text or JSON
  export-playwright <target> [--format json]  Export current workflow as a Playwright spec draft or JSON handoff
  replay <target> --file <path> [--format json]  Replay environment controls + actions against the live page
  replay <target> --json <json> [--format json]  Replay an inline record-actions JSON artifact
  frame <target> [--format json]     List page frames with stable @fN refs (alias: frames)
  overlay <target> [sel|@ref] [--format json]  Detect visible dialogs/overlays and target blockers
  qa <target> [--desktop WxH] [--mobile WxH] [--format json]  Live UI smoke: page info, console health, screenshots, perception, assertions
                                    Optional: --click <sel|@ref> --expect-text text --expect-request pattern
  responsive-audit <target> [--viewport WxH ...] [--out-dir DIR] [--format json]
                                    Built-in responsive visual audit (alias: visual-check).
                                    Defaults to desktop 1440x900 + mobile 390x844.
                                    Collects screenshot, overflow-x, scroll metrics, controls, blank/console signals.
  verify-click <target> <sel|@ref> [--format json]  Click once and assert text/network/console outcomes
                                    --expect-text text --expect-request pattern --expect-status code --no-console-errors
  net   <target>                    Network performance entries
  click   <target> <sel|@ref> [--format json] [--qa|--summary]  Click element by CSS selector or @ref
                                    --js / -j: use HTMLElement.click() (JS fallback)
                                    --qa/--summary: compact pass/fail QA receipt without full DOM dump
  jsclick <target> <sel|@ref>       JS-only click: el.click() instead of CDP mouse events
                                    Use when overlays or hit-testing block the realistic mouse path.
  clickxy <target> <x> <y> [--format json]  Click at CSS pixel coordinates (see coordinate note below)
  type    <target> <text> [--format json]  Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  press   <target> <key> [--format json]  Press key (Enter, Tab, Escape, Backspace, Space, Arrow*)
  scroll  <target> <dir|x,y> [px] [--format json]  Scroll page (down/up/left/right or x,y offset; default 500px)
  hover   <target> <sel|@ref>       Hover over element (triggers :hover, tooltips, dropdowns)
  waitfor <target> <selector> [ms]  Wait for element (default 10s, max 5min)
  waitfor <target> --gone <sel|@ref> [ms]  Wait for element to DISAPPEAR (streaming end)
  waitfor <target> --text "str" [--scope sel] [ms]  Wait for text to appear on page
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  wait    <target> <ms>             Delay inside cdp (also: cdp wait <ms> [target])
  fill    <target> <sel|@ref> <txt> [--format json] Clear field and type text (for form filling)
                                    --react: native value setter + input/change events
  select  <target> <selector> <val> [--format json] Select an option in a <select> element by value
  fullshot <target> [file]          Full-page screenshot (single image — may be hard to read)
  scanshot <target>                 Segmented full-page capture (viewport-sized images, readable)
  styles  <target> <selector> [--root auto|body|document|<sel>]
                                    Get computed styles for element (filtered to meaningful props)
                                    On no-match, error includes root/scope and an eval fallback
  components <target> [--depth N] [@ref|selector] [--max-chars N] [--unsafe-full] [--format json]
                                    React/Vue component tree; targeted props/state requires React fiber.
                                    Props/state are bounded and redacted unless --unsafe-full is explicit.
  cookies <target>                  List cookies for current page
  cookieset <target> <cookie>       Set a cookie: "name=value" or "name=value; domain=.example.com; secure"
  cookiedel <target> <name>         Delete a cookie by name
  dialog  <target> [accept|dismiss] Show dialog history; set auto-accept (default) or auto-dismiss
  viewport <target> [WxH]           Show or set viewport size (e.g. 375x812, 1280x720)
  emulate <target> [dark|light|no-preference|off|status]
                                    Media feature emulation via CDP Emulation.setEmulatedMedia
                                    color-scheme dark|light|no-preference
                                    reduced-motion reduce|no-preference
                                    off/reset clears overrides; JSON returns chrome-cdp-ex.emulate.v1
  upload  <target> <selector> <paths> [--format json]  Upload file(s) to <input type="file"> (comma-separated paths)
  text    <target> [selector]       Clean visible text — optional CSS selector to scope
                                    --root auto|body|document|default|<sel>: search root for selector resolution
                                    On no-match, error includes root/scope and an eval fallback
  table   <target> [selector]       Full table data extraction (tab-separated, no row limit)
  back    <target>                  Navigate back in browser history
  forward <target>                  Navigate forward in browser history
  reload  <target>                  Reload current page and clear console/exception/navigation buffers
  closetab <target>                 Close a browser tab
  netlog  <target> [--clear]        Network request log (XHR/Fetch/Document with status + timing)
  inject <target> <flag> [content]   Live CSS/JS injection with tracking and removal
                                    --css "<text>"   Inject inline <style>
                                    --css-file <url> Inject <link rel="stylesheet">
                                    --js-file <url>  Inject <script src> and wait for load
                                    --remove [id]    Remove injected element(s) (all, or by id)
  cascade <target> <sel|@ref> [prop] [--format json] CSS origin tracing — shows which rules apply, source file + line
                                    Optional: filter to one property (e.g. "background-color"); JSON returns chrome-cdp-ex.cascade.v1
  record <target> [ms]              Record a short timeline of DOM/console/network/navigation events
  record <target> --action click @5 Record events around an action (click/press/fill/select/type/scroll/nav)
  record <target> --until "dom stable"|"network idle"  Record until page quiets (max 30s)
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  batch <target> <cmds> [--parallel] [--format json] Execute multiple commands in one call
                                    --format json returns chrome-cdp-ex.batch.v1 failure handoff
                                    Pipe syntax: 'fill @3 hello | fill @5 world | click @7'
                                    JSON syntax: '[{"cmd":"click","args":["@1"]},{"cmd":"perceive","args":["--diff"]}]'
                                    --parallel  Run read-only/extraction commands concurrently (mutating commands are rejected)
                                    --plain     Human-readable per-step output (default: pretty JSON)
                                    --compact   One line per step (head + first line of result)
  flow  <target> "<steps>" [--format json]  Sequential runner. Steps separated by ";".
                                    Each step is a normal command (e.g. "click @1") or a wait alias:
                                    "wait dom stable" / "wait network idle" — uses settle helper.
                                    Halts on the first failing step; JSON returns chrome-cdp-ex.flow.v1.
                                    Example: flow A7BA "click @1; wait dom stable; summary; console --errors"
  repeat <target> <N> <cmd> [args]  Run a command up to N times (cap 50). Fail-fast by default.
                                    --continue / -c: keep going through errors and report tally.
                                    Cannot wrap repeat/batch/stop (recursion / IPC corruption).
                                    Can wrap flow for multi-step turn loops, e.g.
                                    repeat A7BA 3 flow "click @1; wait dom stable; text .log"
                                    Useful for advancing MUD dialogue ("repeat 5 press space"),
                                    retry-style probes, or short keypress sequences. Re-perceive
                                    between iterations if the DOM changes — refs are not auto-remapped.
                                    Example: repeat A7BA 5 press c
  doctor / ready [--format json]    One-call diagnostics: Node version, skill install path,
                                    daemon socket state, fd limit, CDP_PORT/DevToolsActivePort reachability,
                                    debuggable tab inventory, browser permission, Recommendation, and onboarding next steps.
                                    Readiness: ready | usable-with-warnings | blocked.
                                    Checks expose severity: blocking | warning | advisory | ok.
                                    Headless CDP sessions treat unconfirmed permission as advisory, not a blocker.
                                    No target required. Exits 1 if any check FAILs.
  keepalive <target> <ms>           Extend this tab daemon lifetime (fire-and-forget eval extends 1h)
  open  [url] [--attach-timeout-ms N] [--ready-timeout-ms N] [--ready-selector sel] [--reuse-url] [--format json]
                                    Open a new tab (default: about:blank)
                                    JSON includes schema/target/approval/recommendation/nextSteps for agents.
                                    --reuse-url reuses an existing tab matching the URL when unique.
                                    --attach-timeout-ms 0 returns the target handoff without waiting.
                                    --ready-timeout-ms bounds document.readyState waiting after attach.
                                    --ready-selector also waits for a CSS selector before returning.
                                    Note: each new tab triggers a fresh "Allow debugging?" prompt
  spawn-debug-browser [browser] [--port N] [--url URL] [--profile-dir DIR] [--exe PATH] [--format json]
                                    Launch an isolated debug profile (browser: edge|chrome|brave; default edge, port 9222).
                                    --host HOST binds remote debugging address (default 127.0.0.1).
                                    --headless [new|old], --no-sandbox, --disable-gpu help CI/container/headless runs.
                                    --wait-ms N bounds the readiness probe before success.
                                    Returns ready target prefix + next perceive command when a page is available.
                                    JSON includes pid/profileDir/port/url/targetId/targetPrefix/readiness/cleanup.
                                    Uses --remote-debugging-port + --user-data-dir; does not touch your main profile.
                                    "spawn" is a short alias.
  dismiss-modal <target>            Close common dialog/modal patterns safely (close button, then Escape) —
                                    avoids triggering background shortcuts the way a bare "press Space" does.
  stop  [target]                    Stop daemon(s)

ACTION FEEDBACK
  click, verify-click, jsclick, clickxy, fill, type, press, select, scroll,
  upload, inject, dismiss-modal, and viewport (when resizing) automatically wait for DOM to
  settle and return compact action evidence plus a perceive diff.
  qa returns a semantic QA report and includes action evidence when --click is used.
  back, forward, and nav return action evidence plus a full perceive.
  reload returns action evidence plus a bounded lightweight page observation.
  Each mutating action also snapshots console/exception/network buffers before
  dispatch and reports compact deltas such as console errors, failed requests,
  or requests still pending after the action observation window.
  If that post-action observation times out after the action was sent, the
  command reports success with "observation timed out" instead of a pure timeout.
  No need to manually run perceive or perceive --diff after these actions.
  To re-check what the last action changed, run perceive --since-action.

<target> is a unique targetId prefix from "cdp list" or a saved alias from
"cdp use <target> --name app". If a prefix is ambiguous, use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON IPC (for advanced use / scripting)
  Each tab runs a persistent daemon at Unix socket in the runtime dir (see below).
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: perceive, status, summary, console, frame, snap, controls, eval, eval64, call, wait, keepalive, shot, diff-shot,
  elshot, fullshot, scanshot, html, nav, net, mock, clock, throttle, click, jsclick, clickxy, hover, type, press,
  scroll, fill, select, waitfor, loadall, styles, cookies, cookieset, cookiedel, dialog,
  viewport, emulate, upload, text, table, components, back, forward, reload, closetab, netlog, inject, cascade,
  record, checkpoint, restore, record-actions, export-playwright, replay, report, qa, responsive-audit,
  verify-click, evalraw, batch, flow, repeat, stop.
  The socket disappears after 20 min of inactivity or when the tab closes.
`;

function helpStr() {
  return USAGE;
}

const COMMANDS = Object.freeze([
  { name: 'help', aliases: [], needsTarget: false, mutates: false, outputFormats: ['text'] },
  { name: 'list', aliases: [], needsTarget: false, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'target', aliases: [], needsTarget: false, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'tab-group', aliases: ['tabgroup'], needsTarget: false, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'broadcast', aliases: [], needsTarget: false, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text', 'json'] },
  { name: 'open', aliases: [], needsTarget: false, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text', 'json'] },
  { name: 'doctor', aliases: ['ready'], needsTarget: false, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'spawn-debug-browser', aliases: ['spawn'], needsTarget: false, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text', 'json'] },
  { name: 'attach', aliases: [], needsTarget: false, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'use', aliases: [], needsTarget: false, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'forget', aliases: [], needsTarget: false, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'current', aliases: [], needsTarget: false, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'stop', aliases: [], needsTarget: false, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'perceive', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'snap', aliases: ['snapshot'], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'controls', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'eval', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'eval64', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'call', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'wait', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'keepalive', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'shot', aliases: ['screenshot'], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'diff-shot', aliases: ['diffshot'], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'html', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'nav', aliases: ['navigate'], needsTarget: true, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text', 'json'] },
  { name: 'net', aliases: ['network'], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'mock', aliases: ['network-mock'], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text', 'json'] },
  { name: 'clock', aliases: ['time-travel'], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text', 'json'] },
  { name: 'throttle', aliases: ['network-throttle'], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text', 'json'] },
  { name: 'status', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'console', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'summary', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'frame', aliases: ['frames'], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'overlay', aliases: ['overlays'], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'report', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'checkpoint', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'restore', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text', 'json'] },
  { name: 'record-actions', aliases: ['recordactions'], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'export-playwright', aliases: ['export-pw'], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'replay', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text', 'json'] },
  { name: 'elshot', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'qa', aliases: ['qa-page'], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text', 'json'] },
  { name: 'responsive-audit', aliases: ['visual-check'], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text', 'json'] },
  { name: 'verify-click', aliases: ['verifyclick'], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'click', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'jsclick', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'clickxy', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'type', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'press', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'scroll', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'hover', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'waitfor', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'loadall', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'fill', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'select', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'fullshot', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'scanshot', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'styles', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'components', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'cookies', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'cookieset', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'cookiedel', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'evalraw', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'batch', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'dialog', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'viewport', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'emulate', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text', 'json'] },
  { name: 'upload', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'state-change', outputFormats: ['text', 'json'] },
  { name: 'text', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'table', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'back', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text', 'json'] },
  { name: 'forward', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text', 'json'] },
  { name: 'reload', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'state-change', outputFormats: ['text', 'json'] },
  { name: 'closetab', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'netlog', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'inject', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'state-change', outputFormats: ['text', 'json'] },
  { name: 'cascade', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'record', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'flow', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'repeat', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'dismiss-modal', aliases: ['dismissmodal'], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
]);

const NEEDS_TARGET = new Set(
  COMMANDS
    .filter(command => command.needsTarget)
    .flatMap(command => [command.name, ...command.aliases])
);

function parseTargetAndCommandArgs(cmd, args) {
  let targetPrefix = args[0];
  let cmdArgs = args.slice(1);
  if (cmd === 'wait' && /^\d+$/.test(args[0] || '') && args[1] && !/^\d+$/.test(args[1] || '')) {
    targetPrefix = args[1];
    cmdArgs = [args[0], ...args.slice(2)];
  }
  return { targetPrefix, cmdArgs };
}

function detectCliErrorFormat(args = []) {
  try {
    return parseFormatArgs(args, ['text', 'json']).format;
  } catch {
    return 'text';
  }
}

function targetCommandCliErrorFormat(targetPrefix, cmdArgs = [], originalArgs = []) {
  const targetLooksLikeFlag = targetPrefix && String(targetPrefix).startsWith('--');
  return detectCliErrorFormat(targetLooksLikeFlag ? originalArgs : cmdArgs);
}

function formatArgSuffix(format, { compact = false } = {}) {
  return [
    ...(format && format !== 'text' ? ['--format', format] : []),
    ...(compact ? ['--compact'] : []),
  ];
}

function normalizeTargetCommandArgs(cmd, cmdArgs = []) {
  const args = [...cmdArgs];
  if (cmd === 'type') {
    const fopts = parseCompactFormatArgs(args, ['text', 'json']);
    return [fopts.args.join(' '), ...formatArgSuffix(fopts.format, fopts)];
  }
  if (cmd === 'fill') {
    if (args[0] === '--react') {
      const fopts = parseCompactFormatArgs(args.slice(2), ['text', 'json']);
      return ['--react', args[1], fopts.args.join(' '), ...formatArgSuffix(fopts.format, fopts)];
    }
    const fopts = parseCompactFormatArgs(args.slice(1), ['text', 'json']);
    return [args[0], fopts.args.join(' '), ...formatArgSuffix(fopts.format, fopts)];
  }
  return args;
}

function commandUsageTemplate(cmd = '', targetPrefix = '') {
  const target = targetPrefix || '<target>';
  switch (cmd) {
    case 'nav':
    case 'navigate':
      return `cdp nav ${target} https://example.com`;
    case 'click':
    case 'jsclick':
      return `cdp ${cmd} ${target} <selector|@ref>`;
    case 'clickxy':
      return `cdp clickxy ${target} <x> <y>`;
    case 'fill':
      return `cdp fill ${target} <selector|@ref> <text>`;
    case 'type':
      return `cdp type ${target} <text>`;
    case 'press':
      return `cdp press ${target} <key>`;
    case 'select':
      return `cdp select ${target} <selector> <value>`;
    case 'elshot':
      return `cdp elshot ${target} <selector|@ref>`;
    case 'eval':
      return `cdp eval ${target} <expression>`;
    case 'eval64':
      return `cdp eval64 ${target} <base64-expression>`;
    case 'call':
      return `cdp call ${target} <async-function-expression>`;
    case 'evalraw':
      return `cdp evalraw ${target} <CDP.method> [json]`;
    case 'cookieset':
      return `cdp cookieset ${target} "name=value; domain=.example.com"`;
    case 'cookiedel':
      return `cdp cookiedel ${target} <name>`;
    case 'upload':
      return `cdp upload ${target} <selector> <file-path>`;
    case 'batch':
      return `cdp batch ${target} "fill @3 hello | click @5"`;
    case 'flow':
      return `cdp flow ${target} "click @1; wait dom stable; summary"`;
    case 'replay':
      return `cdp replay ${target} --file <record-actions.json>`;
    case 'restore':
      return `cdp restore ${target} --file <checkpoint.json>`;
    case 'inject':
      return `cdp inject ${target} --css "body { outline: 1px solid red }"`;
    default:
      return `cdp ${cmd || '<command>'}${targetPrefix ? ` ${target}` : ''} <required-args>`;
  }
}

function buildCliErrorRecovery(message, { cmd = '', targetPrefix = '', platform = process.platform } = {}) {
  const lower = String(message || '').toLowerCase();
  const target = targetPrefix || '<target>';
  if (lower.includes('emfile') || lower.includes('too many open files')) {
    const recovery = fdLimitRecovery({ platform });
    const commands = recovery.commands || [];
    return {
      kind: 'fd-limit',
      strategy: recovery.strategy,
      run: commands[0]?.command || 'ulimit -n 4096',
      then: commands[1]?.command || null,
      reason: 'The process ran out of file descriptors while managing Chrome, sockets, screenshots, or session files.',
      commands,
    };
  }
  if (
    lower.includes('cannot reach cdp') ||
    lower.includes('no devtoolsactiveport') ||
    lower.includes('websocket error') ||
    lower.includes('remote-debugging-port')
  ) {
    return {
      kind: 'browser-cdp',
      strategy: 'run-doctor',
      run: 'cdp doctor',
      reason: 'Chrome is not reachable through the configured debugging endpoint.',
    };
  }
  if (
    lower.includes('target id required') ||
    lower.includes('no page list cached') ||
    lower.includes('no target matching prefix')
  ) {
    return {
      kind: 'target-resolution',
      strategy: 'rediscover-target',
      run: 'cdp list  # if empty: cdp open https://example.com',
      then: 'cdp open https://example.com',
      reason: 'The requested tab target could not be resolved from the current page list.',
    };
  }
  if (lower.includes('ambiguous prefix')) {
    return {
      kind: 'target-resolution',
      strategy: 'choose-longer-prefix',
      run: 'cdp list  # copy a longer target prefix',
      reason: 'More than one tab matches the provided target prefix.',
    };
  }
  if (
    lower.includes('target closed') ||
    lower.includes('target destroyed') ||
    lower.includes('inspector.detached') ||
    lower.includes('detached from target') ||
    lower.includes('no target with given id') ||
    lower.includes('session closed') ||
    lower.includes('page, context or browser has been closed')
  ) {
    return {
      kind: 'target-closed',
      strategy: 'rediscover-target',
      run: 'cdp list',
      then: 'cdp open https://example.com',
      reason: 'The tab target appears to be closed, detached, or no longer present in Chrome.',
    };
  }
  if (lower.includes('stale daemon')) {
    const staleTarget = targetPrefix || String(message || '').match(/stale daemon for\s+([A-Za-z0-9_-]+)/i)?.[1] || '<target>';
    return {
      kind: 'stale-daemon',
      strategy: 'restart-target-daemon',
      run: `cdp stop ${staleTarget}`,
      then: 'rerun the original command',
      reason: `The per-target daemon was started from an older checkout or cannot report metadata; restart it before using this target. Use ${ALLOW_STALE_DAEMON_FLAG} only for intentional long-running daemon sessions.`,
    };
  }
  if (
    lower.includes('connection closed before response') ||
    lower.includes('daemon failed to start') ||
    lower.includes('ipc timeout')
  ) {
    return {
      kind: 'daemon-disconnect',
      strategy: 'restart-tab-daemon',
      run: `cdp perceive ${target} -C -d 8`,
      reason: 'The per-tab daemon did not return a usable response.',
    };
  }
  if (lower.includes('unknown command')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help',
      reason: 'The command name does not match the registered CLI commands.',
    };
  }
  if ((cmd === 'nav' || cmd === 'navigate') && lower.includes('url required')) {
    return {
      kind: 'navigation',
      strategy: 'provide-url',
      run: `cdp nav ${target} https://example.com`,
      reason: 'Navigation commands need an explicit http or https URL.',
    };
  }
  if (cmd && lower.includes('required')) {
    return {
      kind: 'usage',
      strategy: 'provide-required-argument',
      run: commandUsageTemplate(cmd, targetPrefix),
      reason: 'The command is missing required input; provide the required argument instead of retrying unchanged.',
    };
  }
  return targetPrefix
    ? {
        kind: 'unknown',
        strategy: 'inspect-status',
        run: `cdp status ${targetPrefix}`,
        reason: 'The failure was not classified; inspect the target status before retrying.',
      }
    : {
        kind: 'unknown',
        strategy: 'run-doctor',
        run: 'cdp doctor',
        reason: 'The failure was not classified; check browser setup and available targets.',
      };
}

function formatCliErrorRecovery(recovery) {
  const lines = [
    'Recovery:',
    `  Kind: ${recovery.kind}`,
    `  Strategy: ${recovery.strategy}`,
    `  Run: ${recovery.run}`,
  ];
  if (recovery.then) lines.push(`  Then: ${recovery.then}`);
  if (recovery.reason) lines.push(`  Reason: ${recovery.reason}`);
  return lines;
}

function cliErrorMessage(err) {
  return String(err?.message || err || '').trim() || 'unknown failure';
}

function buildCliErrorModel(err, { cmd = '', targetPrefix = '', platform = process.platform } = {}) {
  const message = cliErrorMessage(err);
  const recovery = buildCliErrorRecovery(message, { cmd, targetPrefix, platform });
  const nextSteps = [];
  const commandSteps = Array.isArray(recovery.commands) && recovery.commands.length
    ? recovery.commands.map(command => command?.command).filter(Boolean)
    : [recovery.run, recovery.then];
  for (const step of commandSteps) {
    if (step && !nextSteps.includes(step)) nextSteps.push(step);
  }
  return {
    schema: 'chrome-cdp-ex.cli-error.v1',
    ok: false,
    command: cmd || null,
    targetPrefix: targetPrefix || null,
    error: { message },
    recovery,
    nextSteps,
  };
}

function formatCliError(err, { cmd = '', targetPrefix = '', format = 'text', platform = process.platform } = {}) {
  if (format === 'json') return formatJson(buildCliErrorModel(err, { cmd, targetPrefix, platform }));
  const message = String(err?.message || err || '').trim();
  if (!message) {
    const recovery = buildCliErrorRecovery('unknown failure', { cmd, targetPrefix, platform });
    return ['Error: unknown failure', ...formatCliErrorRecovery(recovery), `Next: ${recovery.run}`].join('\n');
  }
  if (message.startsWith('Action failure:')) return message;
  const lines = [message.startsWith('Error:') ? message : `Error: ${message}`];
  if (/^Next:/m.test(message)) return lines.join('\n');

  const recovery = buildCliErrorRecovery(message, { cmd, targetPrefix, platform });
  lines.push(...formatCliErrorRecovery(recovery));
  lines.push(`Next: ${recovery.run}`);
  return lines.join('\n');
}

function exitCliError(err, { cmd = '', targetPrefix = '', format = 'text', platform = process.platform } = {}) {
  console.error(formatCliError(err, { cmd, targetPrefix, format, platform }));
  process.exit(1);
}

function argsWithoutFormat(args = []) {
  try {
    return parseFormatArgs(args, ['text', 'json']).args;
  } catch {
    return args;
  }
}

function targetPrefixForDisplay(targetId) {
  return String(targetId || '').slice(0, 8) || '<target>';
}

function parseNonNegativeInteger(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parseOpenArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const positional = [];
  let attachTimeoutMs = DEFAULT_OPEN_ATTACH_TIMEOUT_MS;
  let readyTimeoutMs = null;
  let readySelector = null;
  let reuseUrl = false;
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--attach-timeout-ms') {
      attachTimeoutMs = parseNonNegativeInteger(fopts.args[++i], 'open: --attach-timeout-ms');
    } else if (String(token).startsWith('--attach-timeout-ms=')) {
      attachTimeoutMs = parseNonNegativeInteger(String(token).slice('--attach-timeout-ms='.length), 'open: --attach-timeout-ms');
    } else if (token === '--ready-timeout-ms') {
      readyTimeoutMs = parseNonNegativeInteger(fopts.args[++i], 'open: --ready-timeout-ms');
    } else if (String(token).startsWith('--ready-timeout-ms=')) {
      readyTimeoutMs = parseNonNegativeInteger(String(token).slice('--ready-timeout-ms='.length), 'open: --ready-timeout-ms');
    } else if (token === '--ready-selector') {
      readySelector = fopts.args[++i];
      if (!readySelector) throw new Error('open: --ready-selector requires a CSS selector');
    } else if (String(token).startsWith('--ready-selector=')) {
      readySelector = String(token).slice('--ready-selector='.length);
      if (!readySelector) throw new Error('open: --ready-selector requires a CSS selector');
    } else if (token === '--reuse-url') {
      reuseUrl = true;
    } else if (String(token).startsWith('-')) {
      throw new Error(`open: unknown argument ${token}`);
    } else {
      positional.push(token);
    }
  }
  if (positional.length > 1) throw new Error(`open: unknown argument ${positional[1]}`);
  return {
    url: positional[0] || 'about:blank',
    format: fopts.format,
    attachTimeoutMs,
    readyTimeoutMs: readyTimeoutMs ?? (attachTimeoutMs > 0 ? DEFAULT_OPEN_READY_TIMEOUT_MS : 0),
    readySelector,
    reuseUrl,
  };
}

function openReadyProbeScript(selector = null) {
  return `JSON.stringify({ href: location.href, readyState: document.readyState, selectorFound: ${selector ? `Boolean(document.querySelector(${JSON.stringify(selector)}))` : 'true'} })`;
}

async function waitForOpenReady(targetId, {
  timeoutMs = DEFAULT_OPEN_READY_TIMEOUT_MS,
  url = '',
  selector = null,
  createCdp = () => new CDP(),
  getWsUrlFn = getWsUrl,
} = {}) {
  const timeout = Math.min(Math.max(timeoutMs, 0), 300000);
  if (timeout <= 0) {
    return { attempted: false, ok: false, reason: 'disabled', href: null, readyState: null, selector, selectorFound: false, timeoutMs: timeout };
  }
  const deadline = Date.now() + timeout;
  let lastState = null;
  while (true) {
    const cdp = createCdp();
    try {
      const probeTimeoutMs = Math.min(1000, Math.max(100, deadline - Date.now()));
      await cdp.connect(await getWsUrlFn());
      const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, probeTimeoutMs);
      const result = await cdp.send('Runtime.evaluate', {
        expression: openReadyProbeScript(selector),
        returnByValue: true,
        awaitPromise: false,
      }, attached.sessionId, probeTimeoutMs);
      if (result.exceptionDetails) {
        throw new Error(runtimeExceptionMessage(result.exceptionDetails));
      }
      const raw = result.result?.value ?? '{}';
      try {
        lastState = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        lastState = { href: null, readyState: String(raw || '').trim() || null };
      }
      const readyState = lastState?.readyState || null;
      const href = lastState?.href || null;
      const selectorReady = lastState?.selectorFound === true;
      const urlReady = !url || url === 'about:blank' || href === url;
      if (urlReady && selectorReady && /^(interactive|complete)$/.test(readyState || '')) {
        return { attempted: true, ok: true, href, readyState, selector, selectorFound: true, timeoutMs: timeout };
      }
    } catch (e) {
      lastState = { error: e.message || String(e) };
    } finally {
      try { cdp.close(); } catch {}
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(100, remainingMs));
  }
  return { attempted: true, ok: false, href: lastState?.href || null, readyState: lastState?.readyState || null, selector, selectorFound: lastState?.selectorFound === true, error: lastState?.error || null, timeoutMs: timeout };
}

function openNavigationScript(url) {
  return `(function() {
    location.assign(${JSON.stringify(url)});
    return JSON.stringify({ method: 'location.assign', target: ${JSON.stringify(url)} });
  })()`;
}

async function waitForOpenTargetUrl(targetId, url, timeoutMs = 1000) {
  if (!url || url === 'about:blank') return { ok: true, href: 'about:blank' };
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastHref = null;
  let lastError = null;
  while (Date.now() <= deadline) {
    const cdp = new CDP();
    try {
      await cdp.connect(await getWsUrl());
      const { targetInfos } = await cdp.send('Target.getTargets', {}, undefined, Math.min(1000, Math.max(100, deadline - Date.now() + 100)));
      const target = (targetInfos || []).find(t => t.targetId === targetId);
      lastHref = target?.url || null;
      if (lastHref === url) return { ok: true, href: lastHref };
    } catch (e) {
      lastError = e.message || String(e);
    } finally {
      try { cdp.close(); } catch {}
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(100, remainingMs));
  }
  return { ok: false, href: lastHref, error: lastError };
}

async function navigateOpenTarget(targetId, sp, url) {
  if (!url || url === 'about:blank') return { attempted: false, ok: true, reason: 'about:blank' };
  const attempts = [];
  const initialUrl = await waitForOpenTargetUrl(targetId, url, 1500);
  if (initialUrl.ok) {
    return { attempted: true, ok: true, method: 'Target.createTarget', href: initialUrl.href, error: null };
  }
  const cdp = new CDP();
  try {
    await cdp.connect(await getWsUrl());
    await cdp.send('Target.activateTarget', { targetId }, undefined, 5000).catch(() => {});
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, 5000);
    const sid = attached.sessionId;
    await cdp.send('Page.enable', {}, sid, 2000).catch(() => {});
    try {
      const nav = await cdp.send('Page.navigate', { url }, sid, 5000);
      if (nav?.errorText) throw new Error(nav.errorText);
      return { attempted: true, ok: true, method: 'Page.navigate', error: null };
    } catch (e) {
      attempts.push({ method: 'Page.navigate', error: e.message || String(e) });
    }
    try {
      await cdp.send('Runtime.evaluate', {
        expression: openNavigationScript(url),
        returnByValue: false,
        awaitPromise: false,
      }, sid, 5000);
      return { attempted: true, ok: true, method: 'Runtime.evaluate location.assign', error: null, attempts };
    } catch (e) {
      attempts.push({ method: 'Runtime.evaluate location.assign', error: e.message || String(e) });
    }
  } catch (e) {
    attempts.push({ method: 'direct-cdp', error: e.message || String(e) });
  } finally {
    try { cdp.close(); } catch {}
  }

  const afterDirectUrl = await waitForOpenTargetUrl(targetId, url, 1500);
  if (afterDirectUrl.ok) {
    return { attempted: true, ok: true, method: 'Target.url-observed', href: afterDirectUrl.href, attempts, error: null };
  }

  let conn = null;
  try {
    conn = await connectToSocket(sp);
    const resp = await sendCommand(conn, { cmd: 'eval', args: [openNavigationScript(url)] });
    return {
      attempted: true,
      ok: resp.ok === true,
      method: 'daemon eval location.assign',
      attempts,
      error: resp.ok ? null : (resp.error || 'navigation failed'),
    };
  } catch (e) {
    attempts.push({ method: 'daemon eval location.assign', error: e.message || String(e) });
    const afterDaemonUrl = await waitForOpenTargetUrl(targetId, url, 1500);
    if (afterDaemonUrl.ok) {
      return { attempted: true, ok: true, method: 'Target.url-observed', href: afterDaemonUrl.href, attempts, error: null };
    }
    return { attempted: true, ok: false, method: 'daemon eval location.assign', attempts, error: e.message || String(e) };
  } finally {
    try { conn?.end(); } catch {}
  }
}

function formatOpenReadyMessage(targetId, url = '') {
  const target = targetPrefixForDisplay(targetId);
  const lines = [
    'Tab ready — debugging approved.',
    `Target: ${target}${url ? `  ${url}` : ''}`,
    `Next: cdp click ${target} @ref  # choose a ref from the perception below`,
    `Then: cdp perceive ${target} --since-action`,
    `Report: cdp report ${target}`,
  ];
  return lines.join('\n');
}

function buildOpenModel({ targetId, url = '', attached = false, autoPerceive = null, ready = null, navigation = null } = {}) {
  const target = targetPrefixForDisplay(targetId);
  const approved = attached === true;
  const defaultAutoPerceive = approved
    ? { attempted: false, ok: false, reason: 'not-run' }
    : { attempted: false, ok: false, reason: 'not-attached' };
  const autoPerceiveModel = autoPerceive || defaultAutoPerceive;
  const recommendation = approved && autoPerceiveModel.ok
    ? goldenPathActRecommendation(target, { fromPerceptionBelow: true })
    : approved
    ? goldenPathPerceiveRecommendation(target)
    : goldenPathBrowserPermissionRecommendation(target);
  const nextSteps = recommendation.commands;
  return {
    schema: 'chrome-cdp-ex.open.v1',
    targetId,
    targetPrefix: target,
    url,
    attached: approved,
    approval: approved ? 'approved' : 'pending',
    navigation,
    ready,
    autoPerceive: autoPerceiveModel,
    recommendation,
    nextSteps,
  };
}

function formatOpenTimeoutMessage(targetId) {
  const target = targetPrefixForDisplay(targetId);
  return [
    'Timeout waiting for debugging approval. Tab created but daemon not connected.',
    `Target: ${target}`,
    'If Chrome asks "Allow debugging?", click Allow first.',
    `Next: cdp perceive ${target} -C -d 8`,
  ].join('\n');
}

function formatOpenAutoPerceiveFailure(err, targetId) {
  const target = targetPrefixForDisplay(targetId);
  return [
    'Auto-perceive failed after the tab was attached.',
    formatCliError(err, { cmd: 'perceive', targetPrefix: target }),
  ].join('\n');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  // Daemon mode (internal)
  if (cmd === '_daemon') { await runDaemon(args[0]); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(helpStr()); process.exit(0);
  }

  // List — use existing daemon if available, otherwise direct
  if (cmd === 'list' || cmd === 'ls') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    if (fopts.args.length) {
      console.error(formatCliError(`list: unknown argument ${fopts.args[0]}`, { cmd, format: fopts.format }));
      process.exit(1);
    }
    let pages;
    const existingSock = findAnyDaemonSocket();
    if (existingSock) {
      try {
        const conn = await connectToSocket(existingSock);
        const resp = await sendCommand(conn, { cmd: 'list_raw' });
        if (resp.ok) pages = JSON.parse(resp.result);
      } catch {}
    }
    if (!pages) {
      // No daemon running — connect directly (will trigger one Allow)
      const cdp = new CDP();
      await cdp.connect(await getWsUrl());
      pages = await getPages(cdp);
      cdp.close();
    }
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    const aliasStore = readTargetAliases();
    console.log(formatPageListOutput(pages, _browserInfo, { format: fopts.format, aliases: aliasStore.aliases }));
    process.stdout.write('', () => process.exit(0));
    return;
  }

  // tab-group management (no target required)
  if (cmd === 'tab-group' || cmd === 'tabgroup') {
    try {
      const opts = parseTabGroupArgs(args);
      let store = readTabGroups();
      if (opts.action === 'list') {
        console.log(formatTabGroupStore(store, { format: opts.format }));
        process.exit(0);
      }
      if (opts.action === 'create') {
        const [name, ...members] = opts.args;
        if (!name) throw new Error('tab-group create: name required');
        store = upsertTabGroup(store, { name, members });
        writeTabGroups(store);
        console.log(formatTabGroup(store.groups[normalizeTabGroupName(name)], { format: opts.format }));
        process.exit(0);
      }
      if (opts.action === 'add') {
        const [name, member] = opts.args;
        if (!name || !member) throw new Error('tab-group add: name and target required');
        store = upsertTabGroup(store, { name, members: [member] });
        writeTabGroups(store);
        console.log(formatTabGroup(store.groups[normalizeTabGroupName(name)], { format: opts.format }));
        process.exit(0);
      }
      if (opts.action === 'remove') {
        const [name, member] = opts.args;
        if (!name || !member) throw new Error('tab-group remove: name and target required');
        store = removeTabGroupMember(store, name, member);
        writeTabGroups(store);
        console.log(formatTabGroup(store.groups[normalizeTabGroupName(name)], { format: opts.format }));
        process.exit(0);
      }
      if (opts.action === 'delete') {
        const [name] = opts.args;
        if (!name) throw new Error('tab-group delete: name required');
        store = deleteTabGroup(store, name);
        writeTabGroups(store);
        console.log(opts.format === 'json'
          ? formatJson({ schema: 'chrome-cdp-ex.tab-group-delete.v1', removed: normalizeTabGroupName(name) })
          : `Deleted tab group ${normalizeTabGroupName(name)}`);
        process.exit(0);
      }
      if (opts.action === 'show') {
        const [name] = opts.args;
        if (!name) throw new Error('tab-group show: name required');
        const group = getTabGroup(store, name);
        if (!group) throw new Error(`tab-group: unknown group "${normalizeTabGroupName(name)}"`);
        console.log(formatTabGroup(group, { format: opts.format }));
        process.exit(0);
      }
    } catch (e) {
      console.error(formatCliError(e, { cmd: 'tab-group', format: detectCliErrorFormat(args) }));
      process.exit(1);
    }
  }

  // broadcast a command to every member of a tab-group
  if (cmd === 'broadcast') {
    try {
      const opts = parseBroadcastArgs(args);
      const group = getTabGroup(readTabGroups(), opts.groupName);
      if (!group) throw new Error(`broadcast: unknown group "${opts.groupName}"`);
      if (!group.members.length) throw new Error(`broadcast: group "${opts.groupName}" has no members`);
      const results = [];
      for (const member of group.members) {
        const entry = { target: member, targetPrefix: String(member).slice(0, 8), ok: false, result: null, error: null };
        try {
          // Resolve alias or prefix to a live target, then run via daemon IPC.
          let targetId = null;
          const alias = resolveTargetAlias(member);
          if (alias?.targetId) targetId = alias.targetId;
          else {
            const daemonIds = listDaemonSockets().map(d => d.targetId);
            const matches = daemonIds.filter(id => id.toUpperCase().startsWith(String(member).toUpperCase()));
            if (matches.length === 1) targetId = matches[0];
            else if (existsSync(PAGES_CACHE)) {
              const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
              targetId = resolvePrefix(member, pages.map(p => p.targetId), 'target');
            } else {
              throw new Error(`cannot resolve target ${member}; run cdp list`);
            }
          }
          entry.targetPrefix = targetPrefixForDisplay(targetId);
          const conn = await getOrStartTabDaemon(targetId, { env: aliasEnv(alias) });
          const resp = await sendCommand(conn, { cmd: opts.command, args: opts.commandArgs });
          try { conn.end(); } catch {}
          if (resp.ok) {
            entry.ok = true;
            entry.result = resp.result;
          } else {
            entry.error = resp.error || 'command failed';
          }
        } catch (e) {
          entry.error = e.message || String(e);
        }
        results.push(entry);
      }
      const model = buildBroadcastModel({
        groupName: opts.groupName,
        command: opts.command,
        commandArgs: opts.commandArgs,
        results,
        fullResults: opts.fullResults,
      });
      console.log(opts.format === 'json' ? formatJson(model) : formatBroadcastResult(model));
      process.exit(model.failed ? 1 : 0);
    } catch (e) {
      console.error(formatCliError(e, { cmd: 'broadcast', format: detectCliErrorFormat(args) }));
      process.exit(1);
    }
  }

  // Target selection by URL/title (no target prefix required)
  if (cmd === 'target') {
    try {
      const opts = parseTargetSelectArgs(args);
      let pages;
      const existingSock = findAnyDaemonSocket();
      if (existingSock) {
        try {
          const conn = await connectToSocket(existingSock);
          const resp = await sendCommand(conn, { cmd: 'list_raw' });
          if (resp.ok) pages = JSON.parse(resp.result);
        } catch {}
      }
      if (!pages) {
        const cdp = new CDP();
        await cdp.connect(await getWsUrl());
        pages = await getPages(cdp);
        cdp.close();
      }
      writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
      const selection = selectPageTarget(pages, opts);
      console.log(formatTargetSelect(selection, pages, { format: opts.format }));
      process.stdout.write('', () => process.exit(0));
      return;
    } catch (e) {
      console.error(formatCliError(e, { cmd, format: detectCliErrorFormat(args) }));
      process.exit(1);
    }
  }

  // Open new tab
  if (cmd === 'open') {
    const opts = parseOpenArgs(args);
    const url = opts.url;
    if (url !== 'about:blank') validateUrl(url);

    // Reuse an existing tab with the same/similar URL when requested.
    if (opts.reuseUrl && url !== 'about:blank') {
      let pages;
      const existingSock = findAnyDaemonSocket();
      if (existingSock) {
        try {
          const conn = await connectToSocket(existingSock);
          const resp = await sendCommand(conn, { cmd: 'list_raw' });
          if (resp.ok) pages = JSON.parse(resp.result);
        } catch {}
      }
      if (!pages) {
        const cdp = new CDP();
        await cdp.connect(await getWsUrl());
        pages = await getPages(cdp);
        cdp.close();
      }
      writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
      try {
        const selection = selectPageTarget(pages, { url, exact: false });
        const model = buildOpenModel({
          targetId: selection.targetId,
          url: selection.page.url || url,
          attached: true,
          navigation: { attempted: false, ok: true, method: 'reuse-url', href: selection.page.url || url },
          ready: { attempted: false, ok: true, reason: 'reused-existing-tab' },
          autoPerceive: { attempted: false, ok: false, reason: 'reuse-url' },
        });
        model.reused = true;
        if (opts.format === 'json') {
          console.log(formatJson(model));
          return;
        }
        console.log(`Reused existing tab: ${selection.targetPrefix}  ${selection.page.url || url}`);
        console.log(`Next: cdp perceive ${selection.targetPrefix} -C -d 8`);
        return;
      } catch (e) {
        // Zero matches: fall through and open a new tab.
        // Ambiguous matches: fail closed so agents do not open yet another duplicate.
        if (/pages matched/i.test(e.message || '')) {
          console.error(formatCliError(e, { cmd: 'open', format: opts.format }));
          process.exit(1);
        }
      }
    }

    const cdp = new CDP();
    await cdp.connect(await getWsUrl());
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    // Refresh cache; new tab may not appear in getTargets immediately, so add it manually
    const pages = await getPages(cdp);
    if (!pages.some(p => p.targetId === targetId)) {
      pages.push({ targetId, title: url, url });
    }
    cdp.close();
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    if (opts.format === 'text') {
      console.log(`Opened new tab: ${targetId.slice(0, 8)}  ${url}`);
    }

    // Auto-attach: start daemon and wait for user to click "Allow debugging?"
    if (opts.format === 'text') {
      console.log(`Waiting for "Allow debugging?" approval in Chrome... (up to ${formatDuration(opts.attachTimeoutMs)})`);
    }
    const sp = sockPath(targetId);
    if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    const child = spawn(process.execPath, [process.argv[1], '_daemon', targetId], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    let attached = false;
    const attachDeadline = Date.now() + opts.attachTimeoutMs;
    while (Date.now() < attachDeadline) {
      const remainingMs = attachDeadline - Date.now();
      try {
        const conn = await connectToSocket(sp, { timeoutMs: Math.min(DAEMON_ALLOW_DELAY, Math.max(1, remainingMs)) });
        conn.end();
        attached = true;
        break;
      } catch {}
      await sleep(Math.min(DAEMON_ALLOW_DELAY, remainingMs));
    }
    const navigation = attached
      ? await navigateOpenTarget(targetId, sp, url)
      : { attempted: false, ok: false, reason: 'not-attached' };
    const ready = attached
      ? await waitForOpenReady(targetId, { timeoutMs: opts.readyTimeoutMs, url, selector: opts.readySelector })
      : { attempted: false, ok: false, reason: 'not-attached', timeoutMs: opts.readyTimeoutMs };
    if (opts.format === 'json') {
      console.log(formatJson(buildOpenModel({
        targetId,
        url,
        attached,
        navigation,
        ready,
        autoPerceive: attached
          ? { attempted: false, ok: false, reason: 'json-output' }
          : { attempted: false, ok: false, reason: 'not-attached' },
      })));
      return;
    }
    if (attached) {
      console.log(formatOpenReadyMessage(targetId, url));
      // Auto-perceive: give agent immediate page understanding (matches nav behavior)
      try {
        const conn = await connectToSocket(sp);
        const resp = await sendCommand(conn, { cmd: 'perceive', args: [] });
        conn.end();
        if (resp.ok && resp.result) console.log('---\n' + resp.result);
      } catch (e) {
        console.error(formatOpenAutoPerceiveFailure(e, targetId));
      }
    } else {
      console.log(formatOpenTimeoutMessage(targetId));
    }
    return;
  }

  // Stop
  if (cmd === 'stop') {
    await stopDaemons(args[0]);
    return;
  }

  // Doctor / ready — one-call diagnostics, no target needed
  if (cmd === 'doctor' || cmd === 'ready') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    if (fopts.args.length) {
      console.error(formatCliError(`doctor: unknown argument ${fopts.args[0]}`, { cmd, format: fopts.format }));
      process.exit(1);
    }
    const checks = await runDoctorChecks();
    console.log(formatDoctorOutput(checks, { format: fopts.format }));
    process.exit(checks.some(check => check.status === 'FAIL') ? 1 : 0);
  }

  // spawn-debug-browser / spawn — launch isolated debug profile (no target)
  if (cmd === 'spawn-debug-browser' || cmd === 'spawn') {
    try {
      const out = await spawnDebugBrowserStr(args);
      console.log(out);
      process.exit(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd }));
      process.exit(1);
    }
  }

  if (cmd === 'attach' || cmd === 'use') {
    try {
      const parsed = parseAliasCommandArgs(args, cmd);
      const store = readTargetAliases();
      const next = upsertTargetAlias(store, {
        name: parsed.name,
        targetId: parsed.targetId,
        port: parsed.port,
        host: parsed.host,
      });
      writeTargetAliases(next);
      console.log(formatAliasRecord(next.aliases[normalizeAliasName(parsed.name)], { format: parsed.format }));
      process.exit(0);
    } catch (e) {
      const format = detectCliErrorFormat(args);
      console.error(formatCliError(e, { cmd, format }));
      process.exit(1);
    }
  }

  if (cmd === 'forget') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    const name = fopts.args[0];
    if (!name) exitCliError('forget requires an alias name', { cmd, format: fopts.format });
    const next = removeTargetAlias(readTargetAliases(), name);
    writeTargetAliases(next);
    console.log(fopts.format === 'json'
      ? formatJson({ schema: 'chrome-cdp-ex.alias-forget.v1', removed: name, current: next.current })
      : `Forgot @${name}`);
    process.exit(0);
  }

  if (cmd === 'current') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    if (fopts.args.length) exitCliError(`current: unknown argument ${fopts.args[0]}`, { cmd, format: fopts.format });
    console.log(formatCurrentAlias(readTargetAliases(), { format: fopts.format }));
    process.exit(0);
  }

  // Targetless wait: avoids shell sleep policy for simple delays.
  if (cmd === 'wait' && /^\d+$/.test(args[0] || '') && !args[1]) {
    console.log(await waitStr(args[0]));
    return;
  }

  // Page commands — need target prefix
  if (!NEEDS_TARGET.has(cmd)) {
    const cliErrorFormat = detectCliErrorFormat(args);
    console.error(formatCliError(`Unknown command: ${cmd}`, { cmd, format: cliErrorFormat }));
    if (cliErrorFormat === 'text') {
      console.error('');
      console.log(helpStr());
    }
    process.exit(1);
  }

  const targetCommandArgs = [...args];
  let allowStaleDaemon = process.env.CDP_ALLOW_STALE_DAEMON === '1';
  const allowStaleDaemonFlagIndex = targetCommandArgs.indexOf(ALLOW_STALE_DAEMON_FLAG);
  if (allowStaleDaemonFlagIndex !== -1) {
    allowStaleDaemon = true;
    targetCommandArgs.splice(allowStaleDaemonFlagIndex, 1);
  }

  let { targetPrefix, cmdArgs } = parseTargetAndCommandArgs(cmd, targetCommandArgs);
  let cliErrorFormat = targetCommandCliErrorFormat(targetPrefix, cmdArgs, targetCommandArgs);
  if (targetPrefix && String(targetPrefix).startsWith('--')) {
    try {
      const fopts = parseFormatArgs(targetCommandArgs, ['text', 'json']);
      cliErrorFormat = fopts.format;
      targetPrefix = fopts.args[0];
      cmdArgs = fopts.args.slice(1);
    } catch (e) {
      console.error(formatCliError(e, { cmd }));
      process.exit(1);
    }
  }
  if (!targetPrefix) {
    console.error(formatCliError('target ID required. Run "cdp list" first.', { cmd, format: cliErrorFormat }));
    process.exit(1);
  }

  // Resolve prefix → full targetId from cache or running daemon
  let targetId;
  let targetAlias = resolveTargetAlias(targetPrefix);
  const daemonTargetIds = listDaemonSockets().map(d => d.targetId);
  const daemonMatches = daemonTargetIds.filter(id => id.toUpperCase().startsWith(targetPrefix.toUpperCase()));

  if (targetAlias) {
    targetId = targetAlias.targetId;
  } else if (daemonMatches.length > 0) {
    targetId = resolvePrefix(targetPrefix, daemonTargetIds, 'daemon');
  } else {
    if (!existsSync(PAGES_CACHE)) {
      console.error(formatCliError('No page list cached. Run "cdp list" first.', { cmd, targetPrefix, format: cliErrorFormat }));
      process.exit(1);
    }
    const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
    targetId = resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');
  }

  let conn = await getOrStartTabDaemon(targetId, { env: aliasEnv(targetAlias) });
  if (!allowStaleDaemon) {
    try {
      await assertFreshDaemonConnection(conn, {
        targetPrefix: targetPrefixForDisplay(targetId),
        currentMetadata: collectDaemonMetadata(),
      });
    } catch (e) {
      console.error(formatCliError(e, { cmd, targetPrefix: targetPrefixForDisplay(targetId), format: cliErrorFormat }));
      process.exit(1);
    }
    conn = await connectToSocket(sockPath(targetId));
  }

  if (cmd === 'eval') {
    try {
      cmdArgs = normalizeEvalCliArgs(cmdArgs);
    } catch (error) {
      exitCliError(error.message, { cmd, targetPrefix, format: cliErrorFormat });
    }
  } else if (cmd === 'eval64') {
    const b64 = cmdArgs.join('').trim();
    if (!b64) exitCliError('base64 expression required', { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs.splice(0, cmdArgs.length, b64);
  } else if (cmd === 'call') {
    const expr = cmdArgs.join(' ');
    if (!expr) exitCliError('expression required', { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs.splice(0, cmdArgs.length, expr);
  } else if (cmd === 'elshot') {
    const checkArgs = argsWithoutFormat(cmdArgs);
    if (!checkArgs[0]) exitCliError('CSS selector required', { cmd, targetPrefix, format: cliErrorFormat });
  } else if (cmd === 'type') {
    const checkArgs = argsWithoutFormat(cmdArgs);
    if (!checkArgs[0]) exitCliError('text required', { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs = normalizeTargetCommandArgs(cmd, cmdArgs);
  } else if (cmd === 'fill') {
    const checkArgs = argsWithoutFormat(cmdArgs);
    if (checkArgs[0] === '--react') {
      if (!checkArgs[1]) exitCliError('selector required', { cmd, targetPrefix, format: cliErrorFormat });
      if (!checkArgs[2]) exitCliError('text required', { cmd, targetPrefix, format: cliErrorFormat });
    } else {
      if (!checkArgs[0]) exitCliError('selector required', { cmd, targetPrefix, format: cliErrorFormat });
      if (!checkArgs[1]) exitCliError('text required', { cmd, targetPrefix, format: cliErrorFormat });
    }
    cmdArgs = normalizeTargetCommandArgs(cmd, cmdArgs);
  } else if (cmd === 'evalraw') {
    // args: [method, ...jsonParts] — join json parts in case of spaces
    if (!cmdArgs[0]) exitCliError('CDP method required', { cmd, targetPrefix, format: cliErrorFormat });
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  } else if (cmd === 'cookieset') {
    if (!cmdArgs[0]) exitCliError('cookie string required (e.g. "name=value; domain=.example.com")', { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs[0] = cmdArgs.join(' '); // join in case of spaces in cookie string
  } else if (cmd === 'cookiedel') {
    if (!cmdArgs[0]) exitCliError('cookie name required', { cmd, targetPrefix, format: cliErrorFormat });
  } else if (cmd === 'upload') {
    if (!cmdArgs[0] || !cmdArgs[1]) exitCliError('selector and file path(s) required', { cmd, targetPrefix, format: cliErrorFormat });
    // args[0] = selector, args[1] = comma-separated file paths (no join needed)
  } else if (cmd === 'batch') {
    const filtered = cmdArgs.filter(a => a !== '--parallel' && a !== '--plain' && a !== '--compact');
    if (!filtered[0]) exitCliError('commands required (pipe syntax or JSON array)', { cmd, targetPrefix, format: cliErrorFormat });
  } else if (cmd === 'flow') {
    const fopts = parseFormatArgs(cmdArgs, ['text', 'json']);
    if (!fopts.args[0]) exitCliError('flow steps required (semicolon-separated). Example: flow <target> "click @1; wait dom stable; summary"', { cmd, targetPrefix, format: cliErrorFormat });
    // Preserve multi-word/unquoted step recipes as one daemon argument.
    cmdArgs.splice(0, cmdArgs.length, ...formatArgSuffix(fopts.format), fopts.args.join(' '));
  } else if (cmd === 'replay') {
    const jsonIndex = cmdArgs.findIndex(a => a === '--json');
    if (jsonIndex !== -1) {
      const jsonPayload = cmdArgs.slice(jsonIndex + 1).join(' ').trim();
      if (!jsonPayload) exitCliError('replay --json requires a record-actions JSON payload', { cmd, targetPrefix, format: cliErrorFormat });
      cmdArgs.splice(jsonIndex + 1, cmdArgs.length - jsonIndex - 1, jsonPayload);
    } else if (!cmdArgs[0]) {
      exitCliError('replay requires --file <path> or --json <record-actions-json>', { cmd, targetPrefix, format: cliErrorFormat });
    }
  } else if (cmd === 'restore') {
    const jsonIndex = cmdArgs.findIndex(a => a === '--json');
    if (jsonIndex !== -1) {
      const jsonPayload = cmdArgs.slice(jsonIndex + 1).join(' ').trim();
      if (!jsonPayload) exitCliError('restore --json requires a checkpoint JSON payload', { cmd, targetPrefix, format: cliErrorFormat });
      cmdArgs.splice(jsonIndex + 1, cmdArgs.length - jsonIndex - 1, jsonPayload);
    } else if (!cmdArgs[0]) {
      exitCliError('restore requires --file <path> or --json <checkpoint-json>', { cmd, targetPrefix, format: cliErrorFormat });
    }
  }

  if (cmd === 'nav' || cmd === 'navigate') {
    const checkArgs = argsWithoutFormat(cmdArgs);
    if (!checkArgs[0]) exitCliError('URL required', { cmd, targetPrefix, format: cliErrorFormat });
  }

  const response = await sendCommand(conn, { cmd, args: cmdArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error(formatCliError(response.error, { cmd, targetPrefix, format: cliErrorFormat }));
    process.exitCode = 1;
  }
}

// Test exports — only available when NODE_ENV=test to avoid side effects
if (process.env.NODE_ENV !== 'test') {
  main().catch(e => {
    const [cmd, ...args] = process.argv.slice(2);
    console.error(formatCliError(e, { cmd, format: detectCliErrorFormat(args) }));
    process.exit(1);
  });
}
export const __test__ = process.env.NODE_ENV === 'test' ? {
  // Data structures
  RingBuffer, CDP,
  // Utilities
  resolvePrefix, getDisplayPrefixLength, sockPath, isRef, validateUrl,
  emptyAliasStore, readTargetAliases, writeTargetAliases, upsertTargetAlias,
  removeTargetAlias, resolveTargetAlias, aliasesForTarget, parseAliasCommandArgs,
  // AX tree helpers
  shouldShowAxNode, formatAxNode, orderedAxChildren,
  // Perceive & snapshot
  parsePerceiveArgs, buildPerceiveDiffModel, formatPerceiveDiffOutput, buildPerceiveTree, perceivePageScript, perceiveStr,
  parseControlsArgs, visibleControlsPageScript, compactVisibleControlsModel, formatVisibleControlLine, formatVisibleControlsText, controlsStr,
  createPerceptionModel, formatPerceptionJson, perceptionModelFromText, perceiveModel, perceiveDiffModel,
  createSessionState, invalidateSessionRefs,
  classifyActionFailure, formatActionFailure,
  buildActionRecoveryPlan,
  createActionResult, buildActionReceipt, formatActionText, runActionWithFeedback,
  parseVerifyClickArgs, buildSemanticInteractionModel, formatSemanticInteractionResult,
  parseQaArgs, buildQaPageModel, formatQaPageReport,
  createActionObservationBaseline, buildActionObservationDelta, applyActionObservationDelta,
  summarizeActionObservationEffects, shouldTrackActionNetworkRequest,
  appendSessionActionLog, appendSessionEventLog, appendSessionScreenshot,
  appendSessionEnvironmentLog, buildRecordEnvironmentModel,
  initializeSessionLog, parseReportArgs, buildSessionReportModel, formatSessionReport, sessionScreenshotDir,
  ensureSessionScreenshotDir, nextSessionScreenshotPath,
  buildRecordActionsModel, formatRecordActions,
  playwrightStepFromCommand, formatPlaywrightSpecFromRecordActions, formatExportPlaywright,
  parseDiffShotArgs, diffShotCompareScript, formatDiffShotResult, diffShotStr,
  checkpointPageScript, sanitizeCheckpointCookies, sanitizeCheckpointStorage, parseCheckpointArgs, checkpointModel, checkpointStr,
  parseCheckpointArtifact, parseRestoreArgs, redactRestoreCommandArgs,
  checkpointCookieToSetCookieParams, restoreStorageScript, restoreCheckpointStr,
  // Command implementations
  formatPageList, buildPageListModel, formatPageListOutput, dialogStr, netlogStr,
  parseMockArgs, formatNetworkMocksSummary, buildMockModel, formatMockText, mockStr, handleMockRequestPaused,
  parseClockArgs, clockPageScript, formatClockSummary, buildClockModel, formatClockText, clockStr,
  parseThrottleArgs, formatThrottleSummary, throttleModel, formatThrottleText, throttleStr,
  injectStr, cascadeStr, recordStr, parseRecordArgs,
  isTimeoutError, parseDelayMs, waitStr, ipcTimeoutForRequest, parseTargetAndCommandArgs, normalizeTargetCommandArgs,
  parseFormatArgs, formatJson, parseConsoleArgs, clearConsoleBaseline, buildConsoleModel, buildStatusModel, summaryModel, formatSummaryText,
  evalStr, evalFireAndForgetStr, parseEvalArgs, normalizeEvalCliArgs, formatEvalValue, wrapAwaitExpression, callStr, formatCallResult, evalBase64Decode,
  parseEmulateArgs, buildEmulateFeatures, buildEmulateModel, formatEmulateText, emulateStr, emptyEmulateState,
  navStr, reloadStr, reloadActionDispatch, observeReloadPage, clickStr, jsClickStr, fillStr, fillReactStr, waitForStr, snapshotStr,
  statusStr, runtimeMetricsStr, clearObservationBuffers,
  parsePageConditionArgs, pageConditionDescription, probePageCondition, parseRepeatArgs, repeatStr, autoActionJsonArgs,
  isBatchParallelUnsafeCommand,
  parseReplayArgs, parseReplayArtifact, replayStepFromAction, replayActionsStr,
  collectDaemonMetadata, assessDaemonFreshness, formatStaleDaemonMessage,
  // 3y-mud feedback additions
  KEY_MAP, PUNCT_KEY_MAP, SHIFTED_PUNCT_KEY_MAP, keyForPress, pressStr,
  formatUnknownRefError, resolveRefNode, scrollSettledRectFunctionDeclaration, formatRefRect, isPriorityPerceiveTextLine,
  parseFrameOnlyRef, parseFrameRef, flattenFrameTree, formatFrameTreeText, framesModel, framesStr,
  resolveFrameRef, storeFrameScopedRefs, qualifyFrameRefsInLines, frameRefFromActionTarget,
  rememberFramePerceiveOutput, baselineOutputForActionTarget, frameViewportOffset,
  parseTextArgs, textPageScript, textStr, formatTextNoMatchError, htmlStr,
  parseShotArgs, shotStr,
  parseSpawnDebugBrowserArgs, detectBrowserPath, buildSpawnDebugBrowserPlan,
  probeTcpPort,
  waitForSpawnedCdp, formatSpawnDebugBrowserReadinessFailure, spawnDebugBrowserStr,
  listSpawnedDebugTargets, pickSpawnedTarget, buildSpawnDebugBrowserModel, formatSpawnDebugBrowserOutput,
  overlayDetectorScript, formatOverlayReport, resolveOverlayTargetPoint, overlayStr,
  dismissModalStr, dismissModalScript,
  // Screenshot
  captureScreenshot, screencastFallback,
  resetScreenshotTier, getScreenshotTier, SCREENSHOT_TIMEOUT,
  // Constants
  ENRICHED_ROLES, INTERACTIVE_ROLES,
  // Cascade source mapping
  decodeVLQ, mapLineToSource, mapInlineSourceMap, stripVitePathQuery, mapStyleSource,
  // Batch / flow / doctor
  formatBatchResults, parseBatchArgs, parseFlowSteps, settleFlow, flowStr,
  formatCliError, buildCliErrorModel, parseOpenArgs, openNavigationScript, openReadyProbeScript, waitForOpenReady, buildOpenModel, formatOpenReadyMessage, formatOpenTimeoutMessage, formatOpenAutoPerceiveFailure,
  helpStr,
  checkNode, checkSkillSymlink, checkDaemonSockets, checkFdLimit, checkCdpReachability, checkBrowserTargets, checkBrowserPermission,
  detectRuntimeEnvironment, checkRuntimeEnvironment,
  doctorWizardModel, doctorWizardSummary, doctorCheckSeverity,
  doctorNextSteps, doctorStatusSummary, buildDoctorModel, formatDoctorOutput,
  formatDoctorReport, runDoctorChecks, doctorStr,
  // Issues #82-#87 helpers
  isBlankPageUrl, pageTargetScore, rankPageTargets, matchPageTargets, selectPageTarget,
  parseTargetSelectArgs, buildTargetSelectModel, formatTargetSelect,
  parseQaModeArgs, buildQaSummaryModel, formatQaSummaryText, truncateTextLines,
  parseResponsiveAuditArgs, buildResponsiveAuditModel, formatResponsiveAuditReport,
  responsiveAuditViewportScript, responsiveAuditStr, countNetworkFailures,
  stylesStr,
  emptyTabGroupStore, normalizeTabGroupName, normalizeTabGroupStore, readTabGroups, writeTabGroups,
  upsertTabGroup, removeTabGroupMember, deleteTabGroup, getTabGroup,
  parseTabGroupArgs, formatTabGroupStore, formatTabGroup,
  parseBroadcastArgs, buildBroadcastModel, formatBroadcastResult,
  parseComponentsArgs, frameworkDetectorScript, reactComponentsTreeScript, vueComponentsTreeScript,
  sanitizeComponentValue, sanitizeComponentResult, componentsStr, chooseAdaptivePerceiveLast,
  COMMANDS, NEEDS_TARGET,
} : undefined;
