import { readFileSync } from 'fs';
import { isProxy } from 'node:util/types';
import {
  COMMAND_SURFACE,
  MCP_RESOURCE_TEMPLATES,
  MCP_RESOURCE_RECORDS,
  MCP_RUN_COMMAND_ALLOWLIST,
  MCP_TOOL_DEFINITIONS,
  MCP_TOOL_MAPPER_BY_NAME,
} from './command-surface.mjs';
import { parseTableRunCommandArgs } from './table-contract.mjs';

export {
  MCP_RESOURCE_TEMPLATES,
  MCP_RUN_COMMAND_ALLOWLIST,
  MCP_TOOL_DEFINITIONS,
};

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
).version;

const MAX_MCP_DATA_DEPTH = 32;
const MAX_MCP_DATA_NODES = 10_000;
const MAX_MCP_ARRAY_ITEMS = 4_096;
const MAX_MCP_OBJECT_KEYS = 256;

export function snapshotMcpData(value, path = 'mcp', state = { nodes: 0, depth: 0 }) {
  state.nodes += 1;
  if (state.nodes > MAX_MCP_DATA_NODES) throw new Error(`${path}: exceeds the MCP data node limit`);
  if (state.depth > MAX_MCP_DATA_DEPTH) throw new Error(`${path}: exceeds the MCP data depth limit`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') throw new Error(`${path}: must contain JSON data only`);
  if (isProxy(value)) throw new Error(`${path}: proxies are not allowed`);
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key === 'symbol')) throw new Error(`${path}: symbol keys are not allowed`);
  const nextState = { nodes: state.nodes, depth: state.depth + 1 };
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new Error(`${path}: must use the standard array prototype`);
    if (value.length > MAX_MCP_ARRAY_ITEMS) throw new Error(`${path}: exceeds the MCP array item limit`);
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new Error(`${path}[${index}]: must be an own data value`);
      }
      if (descriptor.enumerable !== true) throw new Error(`${path}[${index}]: must be enumerable JSON data`);
      output.push(snapshotMcpData(descriptor.value, `${path}[${index}]`, nextState));
      state.nodes = nextState.nodes;
    }
    for (const key of keys) {
      if (key !== 'length' && !/^\d+$/.test(key)) throw new Error(`${path}.${key}: is not allowed`);
    }
    return Object.freeze(output);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path}: must be a plain data object`);
  }
  if (keys.length > MAX_MCP_OBJECT_KEYS) throw new Error(`${path}: exceeds the MCP object key limit`);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value')) throw new Error(`${path}.${key}: must be an own data value`);
    if (descriptor.enumerable !== true) throw new Error(`${path}.${key}: must be enumerable JSON data`);
    Object.defineProperty(output, key, {
      value: snapshotMcpData(descriptor.value, `${path}.${key}`, nextState),
      enumerable: true,
      configurable: false,
      writable: false,
    });
    state.nodes = nextState.nodes;
  }
  return Object.freeze(output);
}


function requireString(args, key) {
  const value = args?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function requireConfirm(args, action) {
  if (args?.confirm !== true) throw new Error(`${action} requires confirm: true`);
}

function optionalFormatJson(command) {
  return [...command, '--format', 'json'];
}

function normalizeAllowlistedCommand(name) {
  const raw = String(name || '').trim();
  if (!raw) throw new Error('command is required');
  if (!MCP_RUN_COMMAND_ALLOWLIST.includes(raw)) {
    throw new Error(`run_command command not allowlisted: ${raw}`);
  }
  return raw;
}

const ALWAYS_CONFIRM_AUTHORIZATION = new Set(['mutation', 'sensitive-read', 'raw-script', 'raw-cdp']);

/** Compatibility export, now derived from the reviewed command authorization owner. */
export const MCP_RUN_COMMAND_MUTATING = Object.freeze(new Set(
  MCP_RUN_COMMAND_ALLOWLIST.filter(spelling => {
    const command = COMMAND_SURFACE.resolve(spelling);
    return command && ALWAYS_CONFIRM_AUTHORIZATION.has(command.authorization);
  }),
));

function tabGroupRequiresConfirm(args) {
  const normalized = [];
  let formatCount = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg !== '--format') {
      normalized.push(arg);
      continue;
    }
    formatCount += 1;
    const format = args[index + 1];
    if (formatCount > 1 || (format !== 'text' && format !== 'json')) return true;
    index += 1;
  }
  const action = String(normalized[0] || '').toLowerCase();
  if (action === 'list') return normalized.length !== 1;
  if (action === 'show') return normalized.length !== 2 || !normalized[1];
  return true;
}

export function argsRequireConfirm(commandName, args = []) {
  const command = COMMAND_SURFACE.resolve(commandName);
  if (!command) throw new Error(`unknown command policy: ${commandName}`);
  if (ALWAYS_CONFIRM_AUTHORIZATION.has(command.authorization)) return true;
  if (command.authorization === 'composite') return true;
  if (command.authorization === 'conditional') {
    if (command.name === 'table') return parseTableRunCommandArgs(args).request.mode === 'collect';
    if (command.name === 'tab-group') return tabGroupRequiresConfirm(args);
    if (command.name === 'record') return args.includes('--action');
    if (command.name === 'console' || command.name === 'netlog') return args.includes('--clear');
    if (command.name === 'diff-shot') return args.includes('--reset');
    if (command.name === 'shot') {
      if (!args[0]) return true;
      const safeFlags = new Set(['--annotate', '-a', '--quiet', '-q', '--verbose', '-v']);
      return args.slice(1).some(arg => !safeFlags.has(String(arg)));
    }
    if (command.name === 'fullshot') return args.length !== 1 || !args[0];
    return true;
  }
  return args.some(arg => /^(--unsafe-full|--include-secrets)$/.test(String(arg)));
}

export function buildMcpResourceCommand(uri) {
  return resolveMcpResource(uri).command;
}

export function resolveMcpResource(uri) {
  let match = null;
  let resource = null;
  for (const candidate of MCP_RESOURCE_RECORDS) {
    const pattern = candidate.uriTemplate
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace('\\{target\\}', '([^/]+)');
    const candidateMatch = String(uri).match(new RegExp(`^${pattern}$`));
    if (candidateMatch) {
      resource = candidate;
      match = candidateMatch;
      break;
    }
  }
  let command = null;
  if (resource?.mapper === 'doctor-status') command = ['doctor', '--format', 'json'];
  if (resource?.mapper === 'session-report') command = ['report', decodeURIComponent(match[1]), '--compact', '--format', 'json'];
  if (resource?.mapper === 'session-screenshot-latest') command = ['shot', decodeURIComponent(match[1])];
  if (command) return Object.freeze({ command: Object.freeze(command), mimeType: resource.mimeType, record: resource });
  throw new Error(`Unknown MCP resource URI: ${uri}`);
}

export function listMcpResources() {
  return Object.freeze(MCP_RESOURCE_RECORDS
    .filter(resource => !resource.uriTemplate.includes('{'))
    .map(resource => Object.freeze({
      uri: resource.uriTemplate,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    })));
}

export function buildMcpToolCommand(name, args = {}) {
  args = snapshotMcpData(args, 'mcp.arguments');
  const mapper = Object.hasOwn(MCP_TOOL_MAPPER_BY_NAME, name) ? MCP_TOOL_MAPPER_BY_NAME[name] : null;
  switch (mapper) {
    case 'doctor':
      return ['doctor', '--format', 'json'];
    case 'list-tabs':
      return ['list', '--format', 'json'];
    case 'open-or-attach': {
      if (args.target || args.name || args.port) {
        const command = ['use'];
        if (args.port) command.push('--port', String(args.port));
        if (args.target) command.push('--target', String(args.target));
        if (args.name) command.push('--name', String(args.name));
        return command;
      }
      requireConfirm(args, 'open_or_attach');
      const command = ['open', args.url || 'about:blank'];
      if (args.reuseUrl) command.push('--reuse-url');
      return optionalFormatJson(command);
    }
    case 'select-target': {
      if (!args.url && !args.title) throw new Error('select_target requires url and/or title');
      const command = ['target'];
      if (args.url) command.push('--url', String(args.url));
      if (args.title) command.push('--title', String(args.title));
      if (args.exact) command.push('--exact');
      return optionalFormatJson(command);
    }
    case 'perceive': {
      const command = ['perceive', requireString(args, 'target')];
      if (args.depth != null) command.push('-d', String(args.depth));
      if (args.cursorInteractive) command.push('-C');
      if (args.selector) command.push('--selector', String(args.selector));
      if (args.sinceAction) command.push('--since-action');
      if (args.cards) command.push('--cards');
      if (args.last != null) command.push('--last', String(args.last));
      else if (args.adaptive !== false) command.push('--adaptive');
      if (args.qa || args.summary) command.push('--qa');
      if (args.maxDiffLines != null) command.push('--max-diff-lines', String(args.maxDiffLines));
      return optionalFormatJson(command);
    }
    case 'controls': {
      const command = ['controls', requireString(args, 'target')];
      if (args.selector) command.push('--selector', String(args.selector));
      if (args.filter) command.push('--filter', String(args.filter));
      if (args.limit != null) command.push('--limit', String(args.limit));
      if (args.compact !== false) command.push('--compact');
      return optionalFormatJson(command);
    }
    case 'overlay': {
      const command = ['overlay', requireString(args, 'target')];
      if (args.selector) command.push(String(args.selector));
      return optionalFormatJson(command);
    }
    case 'screenshot': {
      if (args.path) requireConfirm(args, 'screenshot path');
      const command = ['shot', requireString(args, 'target')];
      if (args.annotate) command.push('--annotate');
      if (args.path) command.push(String(args.path));
      return command;
    }
    case 'click': {
      requireConfirm(args, 'click');
      const command = ['click', requireString(args, 'target')];
      if (args.js) command.push('--js');
      command.push(requireString(args, 'selector'));
      if (args.qa || args.summary) command.push('--qa');
      return optionalFormatJson(command);
    }
    case 'verify-click': {
      requireConfirm(args, 'verify_click');
      const command = ['verify-click', requireString(args, 'target'), requireString(args, 'selector')];
      if (args.expectText) command.push('--expect-text', String(args.expectText));
      if (args.expectRequest) command.push('--expect-request', String(args.expectRequest));
      if (args.expectStatus != null) command.push('--expect-status', String(args.expectStatus));
      if (args.noConsoleErrors) command.push('--no-console-errors');
      if (args.evidence) command.push('--evidence', String(args.evidence));
      return optionalFormatJson(command);
    }
    case 'dismiss-modal': {
      requireConfirm(args, 'dismiss_modal');
      return ['dismiss-modal', requireString(args, 'target'), '--format', 'json'];
    }
    case 'fill': {
      requireConfirm(args, 'fill');
      const command = ['fill', requireString(args, 'target')];
      if (args.react) command.push('--react');
      command.push(requireString(args, 'selector'), String(args.text ?? ''));
      return optionalFormatJson(command);
    }
    case 'viewport': {
      const command = ['viewport', requireString(args, 'target')];
      if (args.size) {
        requireConfirm(args, 'viewport size changes');
        command.push(String(args.size));
      }
      return args.size ? optionalFormatJson(command) : command;
    }
    case 'qa-page': {
      requireConfirm(args, 'qa_page');
      const command = ['qa', requireString(args, 'target')];
      if (args.desktop) command.push('--desktop', String(args.desktop));
      if (args.mobile) command.push('--mobile', String(args.mobile));
      if (args.click) command.push('--click', String(args.click));
      if (args.expectRequest) command.push('--expect-request', String(args.expectRequest));
      if (args.expectStatus != null) command.push('--expect-status', String(args.expectStatus));
      if (args.expectText) command.push('--expect-text', String(args.expectText));
      if (args.noConsoleErrors) command.push('--no-console-errors');
      return optionalFormatJson(command);
    }
    case 'responsive-audit': {
      requireConfirm(args, 'responsive_audit');
      const command = ['responsive-audit', requireString(args, 'target')];
      const viewports = Array.isArray(args.viewports) ? args.viewports : [];
      for (const size of viewports) command.push('--viewport', String(size));
      if (args.outDir) command.push('--out-dir', String(args.outDir));
      if (args.maxControls != null) command.push('--max-controls', String(args.maxControls));
      return optionalFormatJson(command);
    }
    case 'report': {
      const command = ['report', requireString(args, 'target')];
      if (args.all) command.push('--all');
      else if (args.last != null) command.push('--last', String(args.last));
      if (args.qa || args.summary) command.push('--qa');
      else if (!args.all && args.compact !== false) command.push('--compact');
      return optionalFormatJson(command);
    }
    case 'navigate': {
      requireConfirm(args, 'navigate');
      return optionalFormatJson(['nav', requireString(args, 'target'), requireString(args, 'url')]);
    }
    case 'press': {
      requireConfirm(args, 'press');
      return optionalFormatJson(['press', requireString(args, 'target'), requireString(args, 'key')]);
    }
    case 'wait-for': {
      const command = ['waitfor', requireString(args, 'target')];
      if (args.anyOf) {
        command.push('--any-of', String(args.anyOf));
        if (args.scope) command.push('--scope', String(args.scope));
        if (args.timeoutMs != null) command.push(String(args.timeoutMs));
        return command;
      }
      if (args.selectorStable) {
        command.push('--selector-stable', String(args.selectorStable));
        if (args.stableMs != null) command.push(String(args.stableMs));
        if (args.timeoutMs != null) command.push(String(args.timeoutMs));
        return command;
      }
      if (args.text) {
        command.push('--text', String(args.text));
        if (args.scope) command.push('--scope', String(args.scope));
        if (args.timeoutMs != null) command.push(String(args.timeoutMs));
        return command;
      }
      throw new Error('wait_for requires text, anyOf, or selectorStable');
    }
    case 'cascade': {
      const command = ['cascade', requireString(args, 'target'), requireString(args, 'selector')];
      if (args.property) command.push(String(args.property));
      return optionalFormatJson(command);
    }
    case 'components': {
      requireConfirm(args, 'components');
      const command = ['components', requireString(args, 'target')];
      if (args.selector) command.push(String(args.selector));
      return optionalFormatJson(command);
    }
    case 'spawn-debug-browser': {
      requireConfirm(args, 'spawn_debug_browser');
      const command = ['spawn-debug-browser', String(args.browser || 'edge')];
      if (args.port != null) command.push('--port', String(args.port));
      if (args.url) command.push('--url', String(args.url));
      if (args.dailyProfile) command.push('--daily-profile');
      if (args.headless) command.push('--headless');
      if (args.noSandbox) command.push('--no-sandbox');
      return command;
    }
    case 'record-snapshot': {
      const command = ['record', requireString(args, 'target')];
      if (args.durationMs != null) command.push(String(args.durationMs));
      return command;
    }
    case 'session-checkpoint': {
      requireConfirm(args, 'session_checkpoint');
      const command = ['checkpoint', requireString(args, 'target')];
      if (args.unsafeFull) {
        command.push('--unsafe-full');
      }
      return optionalFormatJson(command);
    }
    case 'table': {
      const target = requireString(args, 'target');
      const selector = typeof args.selector === 'string' ? args.selector : null;
      const continuation = typeof args.continue === 'string' ? args.continue : null;
      const collect = args.collect === true;
      if (selector && continuation) throw new Error('table selector is mutually exclusive with continue');
      if (collect && continuation) throw new Error('table collect is mutually exclusive with continue');
      if (collect) requireConfirm(args, 'table');
      const command = ['table', target];
      if (selector) command.push(selector);
      if (collect) command.push('--collect');
      if (typeof args.scrollContainer === 'string') command.push('--scroll-container', args.scrollContainer);
      if (typeof args.loadMore === 'string') command.push('--load-more', args.loadMore);
      if (args.rowKeyColumn != null) {
        if (!Number.isInteger(args.rowKeyColumn) || args.rowKeyColumn < 0 || args.rowKeyColumn > 255) {
          throw new Error('table rowKeyColumn must be an integer in 0..255');
        }
        command.push('--row-key-column', String(args.rowKeyColumn));
      }
      if (continuation) command.push('--continue', continuation);
      return optionalFormatJson(command);
    }
    case 'run-command': {
      const commandName = normalizeAllowlistedCommand(args.command);
      const extra = Array.isArray(args.args) ? [...args.args] : [];
      if (extra.some(arg => typeof arg !== 'string')) {
        throw new Error('run_command args must contain strings only');
      }
      if (argsRequireConfirm(commandName, extra)) requireConfirm(args, `run_command ${commandName}`);
      // Disallow nested shell metacharacters by accepting only plain string args.
      for (const arg of extra) {
        if (/[\n\r\0]/.test(arg)) throw new Error('run_command args cannot contain newlines');
      }
      return [commandName, ...extra];
    }
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

export function createMcpInitializeResult() {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: {
      name: 'chrome-cdp-ex',
      version: MCP_SERVER_VERSION,
    },
    capabilities: {
      tools: {},
      resources: {},
    },
  };
}
