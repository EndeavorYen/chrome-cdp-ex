import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
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
import {
  deniedCommandMessage,
  formatPolicyFailureText,
  navigationBlockedMessage,
  policyPreflightMessage,
  readSessionPolicy,
  urlFlagValue,
} from './session-policy.mjs';

export {
  MCP_RESOURCE_TEMPLATES,
  MCP_RUN_COMMAND_ALLOWLIST,
  MCP_TOOL_DEFINITIONS,
};

/**
 * Newest first. 2025-03-26 is left out on purpose: it requires accepting JSON-RPC batches, which
 * this server rejects (2025-06-18 removed batching again). See negotiateMcpProtocolVersion for
 * what a 2025-03-26 client is offered instead.
 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2024-11-05']);
export const MCP_PROTOCOL_VERSION = MCP_SUPPORTED_PROTOCOL_VERSIONS[0];
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

// Tool annotations are hints a host may use to auto-approve calls or to flag untrusted output, so
// they are derived from the command catalog instead of being written per tool.
// - readOnly / destructive / idempotent come from `authorization`. Only `standard` commands (never
//   gated by confirm) are read-only. `sensitive-read` commands do not change the page, but confirm
//   gates them, so they are not read-only either. Every other authorization can act on the page.
// - openWorld comes from `domains`: a command that talks to the live browser over any CDP domain
//   returns or acts on content from the open web. Only a command with no CDP domain (`report`,
//   which reads the CLI's own session log) is closed-world.
const AUTHORIZATION_HINTS = Object.freeze({
  standard: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true }),
  'sensitive-read': Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true }),
});
const MUTATING_HINTS = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
const TITLE_ACRONYMS = Object.freeze({ qa: 'QA' });

function annotationHintsFor(command) {
  const hints = Object.hasOwn(AUTHORIZATION_HINTS, command.authorization)
    ? AUTHORIZATION_HINTS[command.authorization]
    : MUTATING_HINTS;
  return { ...hints, openWorldHint: command.domains.length > 0 };
}

function toolTitle(name) {
  const text = name.split('_').map(word => TITLE_ACRONYMS[word] || word).join(' ');
  return text[0].toUpperCase() + text.slice(1);
}

function toolAnnotations(toolName) {
  let hints;
  if (toolName !== 'run_command') {
    const owner = COMMAND_SURFACE.commands.find(command => command.mcp.toolName === toolName);
    if (!owner) throw new Error(`mcp.tools.${toolName}: has no owning command`);
    hints = annotationHintsFor(owner);
  } else {
    // run_command can run any allowlisted command, so it carries the widest hints of that list.
    const all = MCP_RUN_COMMAND_ALLOWLIST.map(spelling => annotationHintsFor(COMMAND_SURFACE.resolve(spelling)));
    hints = {
      readOnlyHint: all.every(entry => entry.readOnlyHint),
      destructiveHint: all.some(entry => entry.destructiveHint),
      idempotentHint: all.every(entry => entry.idempotentHint),
      openWorldHint: all.some(entry => entry.openWorldHint),
    };
  }
  return Object.freeze({ title: toolTitle(toolName), ...hints });
}

/** The `tools/list` answer: the reviewed tool catalog plus catalog-derived annotations. */
export const MCP_TOOLS = Object.freeze(MCP_TOOL_DEFINITIONS.map(tool => Object.freeze({
  ...tool,
  annotations: toolAnnotations(tool.name),
})));

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
    if (command.name === 'console') return args.includes('--clear');
    if (command.name === 'netlog') return args.includes('--clear') || args.includes('--unsafe-full') || args.includes('--out');
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
      // secret: a NAME the CLI resolves from CDP_SECRET_<NAME>/CDP_SECRETS_FILE (#469); the
      // value never enters this request. It replaces text, so passing both is an error.
      if (args.secret !== undefined) {
        if (args.text !== undefined) throw new Error('pass text or secret, not both');
        command.push(requireString(args, 'selector'), '--secret', requireString(args, 'secret'));
        return optionalFormatJson(command);
      }
      // text: "" clears the field; a missing text is an error, never a silent clear.
      if (typeof args.text !== 'string') throw new Error('text is required (pass "" to clear the field), or secret: "NAME"');
      command.push(requireString(args, 'selector'), args.text);
      return optionalFormatJson(command);
    }
    case 'drag': {
      requireConfirm(args, 'drag');
      const command = ['drag', requireString(args, 'target'), requireString(args, 'from'), requireString(args, 'to')];
      if (args.steps != null) command.push('--steps', String(args.steps));
      if (args.mode === 'html5' || args.mode === 'pointer') command.push(`--${args.mode}`);
      else if (args.mode != null && args.mode !== 'auto') throw new Error('mode must be auto, html5, or pointer');
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

/** Largest image block a tool result inlines, measured as base64 text (about 768 KB of PNG). */
export const MCP_IMAGE_MAX_BASE64_BYTES = 1024 * 1024;
// Commands whose first stdout line is the path of the single PNG they just wrote.
const MCP_IMAGE_COMMANDS = new Set(['shot', 'elshot', 'fullshot']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Tolerance for filesystems that store modification times coarsely.
const IMAGE_MTIME_SLACK_MS = 2000;

// A tab daemon writes `shot` into the tab's session directory inside the runtime directory.
const SESSION_SCREENSHOT_DIR = /^cdp-[A-Za-z0-9_.-]+-screenshots$/;

function imageNote(reason, path) {
  return { type: 'text', text: `Image not attached: ${reason}. Open ${path} to view it.` };
}

// The session directory an output path lives in ('' for the runtime directory itself), or null
// when the path is not directly in the runtime directory or in a `cdp-<target>-screenshots`
// directory inside it.
function runtimeOutputDir(runtimeDir, path) {
  const root = resolve(runtimeDir);
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/);
  if (parts.some(part => !part || part === '..')) return null;
  if (parts.length === 1) return '';
  if (parts.length !== 2 || !SESSION_SCREENSHOT_DIR.test(parts[0])) return null;
  return resolve(root, parts[0]);
}

// A session directory must be a real directory, never a symlink or junction to elsewhere.
function isRealDirectory(dir) {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// O_NOFOLLOW is POSIX-only; on Windows the lstat check plus the dev/ino match below stand in.
const OPEN_IMAGE_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

// Reads at most `maxBytes + 1` bytes of the file through one descriptor, so the size cap holds
// for the bytes actually read and the file checked is the file read.
function readCappedRegularFile(path, maxBytes, notBeforeMs) {
  let linkStat;
  try {
    linkStat = lstatSync(path, { bigint: true });
  } catch {
    return { reason: 'the file could not be read' };
  }
  if (!linkStat.isFile()) return { reason: 'the path is not a regular file' };
  let fd;
  try {
    fd = openSync(path, OPEN_IMAGE_FLAGS);
  } catch {
    return { reason: 'the file could not be opened (it may be a link)' };
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.dev !== linkStat.dev || stat.ino !== linkStat.ino) {
      return { reason: 'the file changed while it was being read' };
    }
    if (Number(stat.mtimeMs) < notBeforeMs) return { reason: 'the file was not written by this call' };
    const size = Number(stat.size);
    if (size > maxBytes) return { reason: `the PNG is ${size} bytes`, overCap: true };
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maxBytes) return { reason: `the PNG is more than ${maxBytes} bytes`, overCap: true };
    if (length !== size) return { reason: 'the file changed while it was being read' };
    return { bytes: buffer.subarray(0, length) };
  } catch {
    return { reason: 'the file could not be read' };
  } finally {
    closeSync(fd);
  }
}

/**
 * The image block for a screenshot command's output file, a text note saying why it was left
 * out, or null when the command is not a screenshot command that succeeded. Only a fresh PNG
 * the CLI wrote into its runtime directory, or into a tab's screenshot directory there, is read.
 */
export function mcpImageContent(command, result, {
  runtimeDir,
  startedAtMs,
  maxBase64Bytes = MCP_IMAGE_MAX_BASE64_BYTES,
} = {}) {
  const owner = COMMAND_SURFACE.resolve(command?.[0]);
  if (!owner || !MCP_IMAGE_COMMANDS.has(owner.name) || result.code !== 0) return null;
  const path = result.stdout.split(/\r?\n/, 1)[0].trim();
  if (!path) return null;
  if (!isAbsolute(path)) {
    // A caller `path` such as `out.png` is printed as given; other first lines are not paths.
    return /\.[A-Za-z0-9]+$/.test(path) ? imageNote('the command reported a relative path', path) : null;
  }
  const sessionDir = runtimeOutputDir(runtimeDir, resolve(path));
  if (sessionDir === null) return imageNote('the file is outside the chrome-cdp-ex runtime directory', path);
  if (!path.toLowerCase().endsWith('.png')) return imageNote('the file is not a .png file', path);
  if (sessionDir && !isRealDirectory(sessionDir)) {
    return imageNote('the screenshot directory is a link, not a directory', path);
  }
  if (!Number.isFinite(startedAtMs)) return imageNote('the call start time is unknown', path);
  const maxBytes = Math.floor(maxBase64Bytes / 4) * 3;
  const read = readCappedRegularFile(path, maxBytes, startedAtMs - IMAGE_MTIME_SLACK_MS);
  if (read.overCap) return imageNote(`${read.reason}, over the ${maxBase64Bytes}-byte base64 inline cap`, path);
  if (read.reason) return imageNote(read.reason, path);
  // Re-check after the read, so a session directory swapped for a link mid-read is still refused.
  if (sessionDir && !isRealDirectory(sessionDir)) {
    return imageNote('the screenshot directory is a link, not a directory', path);
  }
  if (!read.bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return imageNote('the file is not the PNG the command reported', path);
  }
  return { type: 'image', data: read.bytes.toString('base64'), mimeType: 'image/png' };
}

// A command's versioned JSON output (an object with a string `schema`) becomes structuredContent.
function structuredOutput(stdout) {
  const text = stdout.trim();
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value.schema === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Maps a CLI result to a `tools/call` result: the text, plus image and structured views. */
export function createMcpToolResult(command, result, imageOptions = {}) {
  const text = result.code === 0
    ? result.stdout
    : [result.stderr, result.stdout].filter(Boolean).join('\n');
  const content = [{ type: 'text', text }];
  const image = imageOptions.runtimeDir ? mcpImageContent(command, result, imageOptions) : null;
  if (image) content.push(image);
  const structuredContent = structuredOutput(result.stdout);
  return {
    content,
    ...(structuredContent ? { structuredContent } : {}),
    isError: result.code !== 0,
  };
}

// A supported request is echoed. Otherwise the answer is the newest supported version that is not
// newer than the request, because a client only accepts versions it knows, and an older SDK knows
// older ones. A request for 2025-03-26 gets 2024-11-05, which those SDKs accept.
// A request older than every supported version gets the oldest one. A newer, unknown or malformed
// request gets the newest. Versions are YYYY-MM-DD, so string order is date order.
export function negotiateMcpProtocolVersion(requested) {
  if (MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested;
  if (typeof requested !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(requested)) return MCP_PROTOCOL_VERSION;
  return MCP_SUPPORTED_PROTOCOL_VERSIONS.find(version => version <= requested)
    ?? MCP_SUPPORTED_PROTOCOL_VERSIONS.at(-1);
}

export function createMcpInitializeResult(params = {}) {
  return {
    protocolVersion: negotiateMcpProtocolVersion(params?.protocolVersion),
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

// #466: the text of a tool call the session policy (CDP_DENY_ACTIONS, CDP_ALLOWED_ORIGINS) refuses,
// or null. The MCP server answers with it instead of running the CLI; the CLI and the tab daemon
// apply the same checks again, including to batch/flow/repeat/replay steps.
export function mcpPolicyDenial(command, env = process.env) {
  const [name, ...rest] = Array.isArray(command) ? command : [];
  let policy;
  try {
    policy = readSessionPolicy(env);
  } catch (error) {
    return formatPolicyFailureText(error.message);
  }
  if (!policy) return null;
  const record = COMMAND_SURFACE.resolve(String(name || ''));
  const targetPrefix = record?.needsTarget ? String(rest[0] || '') : '';
  const message = deniedCommandMessage(policy, name, rest)
    || (record?.name === 'open' ? navigationBlockedMessage(policy, rest[0], 'open') : null)
    || (record?.name === 'spawn-debug-browser'
      ? navigationBlockedMessage(policy, urlFlagValue(rest), 'spawn-debug-browser')
      : null)
    || (record?.needsTarget ? policyPreflightMessage(policy, name, rest.slice(1)) : null);
  return message ? formatPolicyFailureText(message, { targetPrefix }) : null;
}
