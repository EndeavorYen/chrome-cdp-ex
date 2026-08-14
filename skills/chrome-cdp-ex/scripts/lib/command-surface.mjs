import { createHash } from 'node:crypto';

const RECORD_KEYS = new Set([
  'name', 'aliases', 'needsTarget', 'mutates', 'feedbackPolicy', 'outputFormats',
  'kind', 'authorization', 'evidencePolicy', 'domains', 'help', 'mcp',
]);
const HELP_KEYS = new Set(['synopsis', 'summary', 'section', 'order']);
const MCP_KEYS = new Set(['exposure', 'toolName', 'mapper']);
const NAME_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const DOMAIN_NAMES = new Set([
  'Accessibility', 'CSS', 'DOM', 'Emulation', 'Fetch', 'Input', 'Network',
  'Page', 'Performance', 'Runtime', 'Target',
]);
const OUTPUT_FORMATS = new Set(['text', 'json']);
const MCP_EXPOSURES = new Set(['none', 'run-command', 'tool', 'tool-and-run-command']);
const MCP_TOOL_MAPPERS = new Set([
  'cascade', 'click', 'components', 'controls', 'dismiss-modal', 'doctor', 'fill',
  'list-tabs', 'navigate', 'open-or-attach', 'overlay', 'perceive', 'press', 'qa-page',
  'record-snapshot', 'report', 'responsive-audit', 'screenshot', 'select-target',
  'session-checkpoint', 'spawn-debug-browser', 'table', 'verify-click', 'viewport', 'wait-for',
]);
const POLICY_BY_KIND = Object.freeze({
  read: Object.freeze({ mutates: false, authorization: 'standard', evidencePolicy: 'none', feedback: false }),
  mutation: Object.freeze({ mutates: true, authorization: 'mutation', evidencePolicy: 'action-receipt', feedback: true }),
  'protected-mutation': Object.freeze({ mutates: false, authorization: 'mutation', evidencePolicy: 'none', feedback: false }),
  'conditional-mutation': Object.freeze({ mutates: false, authorization: 'conditional', evidencePolicy: 'none', feedback: false }),
  composite: Object.freeze({ mutates: false, authorization: 'composite', evidencePolicy: 'none', feedback: false }),
  'sensitive-read': Object.freeze({ mutates: false, authorization: 'sensitive-read', evidencePolicy: 'none', feedback: false }),
  script: Object.freeze({ mutates: false, authorization: 'raw-script', evidencePolicy: 'none', feedback: false }),
  evidence: Object.freeze({ mutates: false, authorization: 'standard', evidencePolicy: 'session-report', feedback: false }),
  'raw-cdp': Object.freeze({ mutates: false, authorization: 'raw-cdp', evidencePolicy: 'raw-audit', feedback: false }),
});
const COMMAND_SURFACE_BRAND = new WeakSet();

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function snapshotObject(value, path) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(path, 'must be a plain data object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be a plain data object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value')) fail(`${path}.${key}`, 'must be an own data property');
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return result;
}

function snapshotArray(value, path, { max = 1024 } = {}) {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(path, 'must be a plain array');
  if (!Number.isSafeInteger(value.length) || value.length > max) fail(path, `exceeds the ${max}-item array limit`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
    if (key === 'length') continue;
    if (!/^\d+$/.test(key)) fail(`${path}.${key}`, 'is not allowed');
    if (!Object.hasOwn(descriptors[key], 'value')) fail(`${path}[${key}]`, 'must be an own data property');
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!descriptors[index]) fail(`${path}[${index}]`, 'must be an own data property');
    result.push(descriptors[index].value);
  }
  return result;
}

function exactKeys(value, allowed, path) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
    if (!allowed.has(key)) fail(`${path}.${key}`, 'is not allowed');
  }
  for (const key of allowed) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
}

function boundedString(value, path, { max = 400, pattern = null, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(path, 'must be a bounded non-empty string');
  if (pattern && !pattern.test(value)) fail(path, 'has an invalid format');
  return value;
}

function stringArray(value, path, { allowed = null, maxItems = 128 } = {}) {
  const values = snapshotArray(value, path, { max: maxItems });
  const seen = new Set();
  return values.map((entry, index) => {
    const item = boundedString(entry, `${path}[${index}]`, { max: 128 });
    if (allowed && !allowed.has(item)) fail(`${path}[${index}]`, 'is unknown');
    if (seen.has(item)) fail(path, `contains duplicate ${item}`);
    seen.add(item);
    return item;
  });
}

function validateHelp(input, commandName, path) {
  const value = snapshotObject(input, path);
  exactKeys(value, HELP_KEYS, path);
  const synopsis = boundedString(value.synopsis, `${path}.synopsis`, { max: 240 });
  const hasUnsafeHelpText = text => [...text].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029;
  });
  if (hasUnsafeHelpText(synopsis)) fail(`${path}.synopsis`, 'must be a safe single line');
  if (synopsis.includes('{{command:')) fail(`${path}.synopsis`, 'must not contain a command marker');
  if (!new RegExp(`^${commandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s|/])`).test(synopsis)) {
    fail(`${path}.synopsis`, 'must begin with the canonical command name');
  }
  const summary = boundedString(value.summary, `${path}.summary`, { max: 400 });
  if (hasUnsafeHelpText(summary)) fail(`${path}.summary`, 'must be a safe single line');
  if (summary.includes('{{command:')) fail(`${path}.summary`, 'must not contain a command marker');
  const section = boundedString(value.section, `${path}.section`, { max: 64, pattern: NAME_RE });
  if (!Number.isSafeInteger(value.order) || value.order < 0 || value.order > 10000) fail(`${path}.order`, 'must be a bounded integer');
  return Object.freeze({ synopsis, summary, section, order: value.order });
}

function validateMcp(input, path) {
  const value = snapshotObject(input, path);
  exactKeys(value, MCP_KEYS, path);
  if (!MCP_EXPOSURES.has(value.exposure)) fail(`${path}.exposure`, 'is unknown');
  const requiresTool = value.exposure === 'tool' || value.exposure === 'tool-and-run-command';
  if (requiresTool) {
    if (value.toolName === null) fail(`${path}.toolName`, 'is required');
    if (value.mapper === null) fail(`${path}.mapper`, 'is required');
    boundedString(value.toolName, `${path}.toolName`, { max: 64, pattern: NAME_RE });
    boundedString(value.mapper, `${path}.mapper`, { max: 64, pattern: NAME_RE });
    if (!MCP_TOOL_MAPPERS.has(value.mapper)) fail(`${path}.mapper`, 'is not a registered MCP tool mapper');
  } else {
    if (value.toolName !== null) fail(`${path}.toolName`, 'must be null');
    if (value.mapper !== null) fail(`${path}.mapper`, 'must be null');
  }
  return Object.freeze({ exposure: value.exposure, toolName: value.toolName, mapper: value.mapper });
}

function validateRecord(input, index) {
  const path = `commands[${index}]`;
  const value = snapshotObject(input, path);
  exactKeys(value, RECORD_KEYS, path);
  const name = boundedString(value.name, `${path}.name`, { max: 64, pattern: NAME_RE });
  const aliases = stringArray(value.aliases, `${path}.aliases`, { maxItems: 64 });
  for (const alias of aliases) {
    if (!NAME_RE.test(alias)) fail(`${path}.aliases`, `invalid alias ${alias}`);
    if (alias === name) fail(`${path}.aliases`, 'must not contain the canonical name');
  }
  if (typeof value.needsTarget !== 'boolean') fail(`${path}.needsTarget`, 'must be boolean');
  if (typeof value.mutates !== 'boolean') fail(`${path}.mutates`, 'must be boolean');
  const feedbackPolicy = value.feedbackPolicy === null
    ? null
    : boundedString(value.feedbackPolicy, `${path}.feedbackPolicy`, { max: 64, pattern: NAME_RE });
  const outputFormats = stringArray(value.outputFormats, `${path}.outputFormats`, { allowed: OUTPUT_FORMATS, maxItems: 2 });
  if (outputFormats.length === 0) fail(`${path}.outputFormats`, 'must not be empty');
  if (!Object.hasOwn(POLICY_BY_KIND, value.kind)) fail(`${path}.kind`, 'is unknown');
  const policy = POLICY_BY_KIND[value.kind];
  if (value.mutates !== policy.mutates) fail(`${path}.mutates`, `must be ${policy.mutates} for ${value.kind}`);
  if (value.authorization !== policy.authorization) fail(`${path}.authorization`, `must be ${policy.authorization} for ${value.kind}`);
  if (value.evidencePolicy !== policy.evidencePolicy) fail(`${path}.evidencePolicy`, `must be ${policy.evidencePolicy} for ${value.kind}`);
  if (policy.feedback && feedbackPolicy === null) fail(`${path}.feedbackPolicy`, `is required for ${value.kind}`);
  if (!policy.feedback && feedbackPolicy !== null) fail(`${path}.feedbackPolicy`, `must be null for ${value.kind}`);
  const domains = stringArray(value.domains, `${path}.domains`, { allowed: DOMAIN_NAMES, maxItems: DOMAIN_NAMES.size });
  return Object.freeze({
    name,
    aliases: Object.freeze(aliases),
    needsTarget: value.needsTarget,
    mutates: value.mutates,
    feedbackPolicy,
    outputFormats: Object.freeze(outputFormats),
    kind: value.kind,
    authorization: value.authorization,
    evidencePolicy: value.evidencePolicy,
    domains: Object.freeze(domains),
    help: validateHelp(value.help, name, `${path}.help`),
    mcp: validateMcp(value.mcp, `${path}.mcp`),
  });
}

export function defineCommandSurface(input) {
  const values = snapshotArray(input, 'commands', { max: 256 });
  if (values.length === 0 || values.length > 256) fail('commands', 'must contain 1..256 records');
  const commands = values.map(validateRecord);
  const lookup = new Map();
  const helpOrders = new Set();
  for (const command of commands) {
    if (helpOrders.has(command.help.order)) fail('commands', `duplicate help order ${command.help.order}`);
    helpOrders.add(command.help.order);
    for (const spelling of [command.name, ...command.aliases]) {
      if (lookup.has(spelling)) fail('commands', `name or alias collision for ${spelling}`);
      lookup.set(spelling, command);
    }
  }
  const frozenCommands = Object.freeze(commands);
  const surface = Object.freeze({
    commands: frozenCommands,
    resolve(name) {
      return typeof name === 'string' ? lookup.get(name) || null : null;
    },
  });
  COMMAND_SURFACE_BRAND.add(surface);
  return surface;
}

export function isCommandSurface(value) {
  return Boolean(value && COMMAND_SURFACE_BRAND.has(value));
}

const MCP_SURFACE_KEYS = new Set(['tools', 'resources', 'runCommandAllowlist']);
const MCP_TOOL_KEYS = new Set(['name', 'description', 'inputSchema']);
const MCP_RESOURCE_KEYS = new Set(['uriTemplate', 'name', 'description', 'mimeType', 'mapper']);
const MCP_RESOURCE_MAPPERS = new Set(['doctor-status', 'session-report', 'session-screenshot-latest']);
const MCP_DATA_LIMITS = Object.freeze({ depth: 16, nodes: 8192, arrayLength: 1024, objectKeys: 1024 });

function snapshotMcpData(input, path, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MCP_DATA_LIMITS.nodes) fail(path, 'exceeds the MCP data node limit');
  if (depth > MCP_DATA_LIMITS.depth) fail(path, 'exceeds the MCP data depth limit');

  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'string') {
    if (input.length > 8192) fail(path, 'must be a bounded string');
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) fail(path, 'must be a finite number');
    return input;
  }
  if (Array.isArray(input)) {
    const values = snapshotArray(input, path, { max: MCP_DATA_LIMITS.arrayLength });
    if (values.length > MCP_DATA_LIMITS.arrayLength) fail(path, 'exceeds the MCP data array limit');
    return Object.freeze(values.map((entry, index) => snapshotMcpData(entry, `${path}[${index}]`, state, depth + 1)));
  }
  if (input && typeof input === 'object') {
    const value = snapshotObject(input, path);
    const keys = Object.keys(value);
    if (keys.length > MCP_DATA_LIMITS.objectKeys) fail(path, 'exceeds the MCP data object-key limit');
    const result = Object.create(null);
    for (const key of keys) {
      if (key.length === 0 || key.length > 256) fail(`${path}.${key}`, 'has an invalid key');
      Object.defineProperty(result, key, {
        value: snapshotMcpData(value[key], `${path}.${key}`, state, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(result);
  }
  fail(path, 'must contain only JSON data');
}

function validateMcpTool(input, index) {
  const path = `mcp.tools[${index}]`;
  const value = snapshotObject(input, path);
  exactKeys(value, MCP_TOOL_KEYS, path);
  const inputSchema = snapshotMcpData(value.inputSchema, `${path}.inputSchema`, { nodes: 0 });
  if (!inputSchema || Array.isArray(inputSchema) || typeof inputSchema !== 'object') {
    fail(`${path}.inputSchema`, 'must be an object');
  }
  return Object.freeze({
    name: boundedString(value.name, `${path}.name`, { max: 64, pattern: NAME_RE }),
    description: boundedString(value.description, `${path}.description`, { max: 1000 }),
    inputSchema,
  });
}

function validateMcpResource(input, index) {
  const path = `mcp.resources[${index}]`;
  const value = snapshotObject(input, path);
  exactKeys(value, MCP_RESOURCE_KEYS, path);
  const mapper = boundedString(value.mapper, `${path}.mapper`, { max: 64, pattern: NAME_RE });
  if (!MCP_RESOURCE_MAPPERS.has(mapper)) fail(`${path}.mapper`, 'is not a registered MCP resource mapper');
  return Object.freeze({
    uriTemplate: boundedString(value.uriTemplate, `${path}.uriTemplate`, { max: 512 }),
    name: boundedString(value.name, `${path}.name`, { max: 128, pattern: NAME_RE }),
    description: boundedString(value.description, `${path}.description`, { max: 1000 }),
    mimeType: boundedString(value.mimeType, `${path}.mimeType`, { max: 128 }),
    mapper,
  });
}

export function defineMcpSurface(input) {
  const value = snapshotObject(input, 'mcp');
  exactKeys(value, MCP_SURFACE_KEYS, 'mcp');
  const tools = snapshotArray(value.tools, 'mcp.tools', { max: 128 }).map(validateMcpTool);
  const resources = snapshotArray(value.resources, 'mcp.resources', { max: 128 }).map(validateMcpResource);
  const runCommandAllowlist = stringArray(value.runCommandAllowlist, 'mcp.runCommandAllowlist', { maxItems: 512 });
  if (tools.length === 0 || tools.length > 128) fail('mcp.tools', 'must contain 1..128 tools');
  if (resources.length > 128) fail('mcp.resources', 'must contain at most 128 resources');
  if (runCommandAllowlist.length > 512) fail('mcp.runCommandAllowlist', 'must contain at most 512 spellings');

  const toolNames = new Set();
  for (const tool of tools) {
    if (toolNames.has(tool.name)) fail('mcp.tools', `contains duplicate tool ${tool.name}`);
    toolNames.add(tool.name);
  }
  const resourceNames = new Set();
  const resourceUris = new Set();
  for (const resource of resources) {
    if (resourceNames.has(resource.name)) fail('mcp.resources', `contains duplicate resource ${resource.name}`);
    if (resourceUris.has(resource.uriTemplate)) fail('mcp.resources', `contains duplicate URI ${resource.uriTemplate}`);
    resourceNames.add(resource.name);
    resourceUris.add(resource.uriTemplate);
  }

  return Object.freeze({
    tools: Object.freeze(tools),
    resources: Object.freeze(resources),
    runCommandAllowlist: Object.freeze(runCommandAllowlist),
  });
}

function deepFreezeTrustedData(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    if (value && typeof value === 'object') {
      for (const key of Reflect.ownKeys(value)) deepFreezeTrustedData(value[key]);
    }
    return value;
  }
  for (const key of Reflect.ownKeys(value)) deepFreezeTrustedData(value[key]);
  return Object.freeze(value);
}

function stringSchema(description, extra = {}) {
  return { type: 'string', description, ...extra };
}

function booleanSchema(description, extra = {}) {
  return { type: 'boolean', description, ...extra };
}

/** Allowlisted CLI commands for the MCP run_command escape hatch. */
export const MCP_RUN_COMMAND_ALLOWLIST = Object.freeze([
  'help', 'doctor', 'ready', 'list', 'tabs', 'ls', 'target', 'open', 'use', 'current', 'forget',
  'perceive', 'controls', 'overlay', 'snap', 'snapshot', 'summary', 'status', 'console',
  'shot', 'screenshot', 'elshot', 'fullshot', 'scanshot', 'diff-shot', 'diffshot',
  'click', 'verify-click', 'jsclick', 'clickxy', 'type', 'press', 'key', 'scroll', 'hover',
  'fill', 'select', 'upload', 'dialog', 'dismiss-modal',
  'nav', 'navigate', 'back', 'forward', 'reload', 'viewport', 'resize', 'emulate',
  'wait', 'waitfor', 'loadall',
  'cascade', 'components', 'frame', 'frames', 'text', 'table', 'html', 'styles',
  'net', 'netlog', 'cookies', 'qa', 'responsive-audit', 'visual-check', 'report',
  'record', 'checkpoint', 'restore', 'record-actions', 'export-playwright',
  'tab-group', 'broadcast', 'spawn-debug-browser', 'spawn', 'attach', 'stop', 'closetab',
  'keepalive', 'mock', 'clock', 'throttle', 'inject',
]);

const MCP_RESOURCE_RECORDS_INPUT = [
  {
    uriTemplate: 'chrome-cdp-ex://doctor/status',
    name: 'doctor-status',
    description: 'Structured doctor readiness model (JSON).',
    mimeType: 'application/json',
    mapper: 'doctor-status',
  },
  {
    uriTemplate: 'chrome-cdp-ex://session/{target}/report',
    name: 'session-report',
    description: 'Compact session report for a target.',
    mimeType: 'application/json',
    mapper: 'session-report',
  },
  {
    uriTemplate: 'chrome-cdp-ex://session/{target}/screenshot/latest',
    name: 'session-screenshot-latest',
    description: 'Capture a fresh viewport screenshot path/result for a target.',
    mimeType: 'text/plain',
    mapper: 'session-screenshot-latest',
  },
];

export const MCP_RESOURCE_TEMPLATES = Object.freeze(MCP_RESOURCE_RECORDS_INPUT.map(resource => Object.freeze({
  uriTemplate: resource.uriTemplate,
  name: resource.name,
  description: resource.description,
  mimeType: resource.mimeType,
})));

export const MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'doctor',
    description: 'Run chrome-cdp-ex readiness diagnostics and return structured setup guidance.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_tabs',
    description: 'List debuggable browser tabs and named target aliases.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'open_or_attach',
    description: 'Open a URL in a debuggable tab, or register a named alias for an existing target.',
    inputSchema: {
      type: 'object',
      properties: {
        url: stringSchema('HTTP(S) URL to open. Omit when only attaching an alias.'),
        target: stringSchema('Existing CDP target id or prefix to alias.'),
        port: stringSchema('CDP port for the target or browser session.'),
        name: stringSchema('Optional local alias name for later tool calls.'),
        reuseUrl: booleanSchema('Reuse an existing tab matching the URL when unique.'),
        confirm: booleanSchema('Required when opening a new tab because this mutates browser state.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'select_target',
    description: 'Select a debuggable page target by URL and/or title substring (or exact match).',
    inputSchema: {
      type: 'object',
      properties: {
        url: stringSchema('URL or URL substring to match.'),
        title: stringSchema('Page title or title substring to match.'),
        exact: booleanSchema('Require exact URL/title match.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'perceive',
    description: 'Capture structured page perception with refs, layout, and console health.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        depth: { type: 'integer', minimum: 1, maximum: 20, description: 'Tree depth limit.' },
        cursorInteractive: booleanSchema('Include visible clickable controls and @c refs.'),
        selector: stringSchema('Optional CSS selector scope.'),
        sinceAction: booleanSchema('Return the causal diff since the last mutating action.'),
        adaptive: booleanSchema('Use density/error-aware text-row budgeting. Defaults to true.'),
        last: { type: 'integer', minimum: 1, maximum: 500, description: 'Explicit text-row budget; overrides adaptive mode.' },
        qa: booleanSchema('Return a compact QA summary instead of full perception.'),
        cards: booleanSchema('Return compact feed cards (article/listitem) instead of the full accessibility tree.'),
        maxDiffLines: { type: 'integer', minimum: 0, maximum: 500, description: 'Truncate long text previews in QA mode.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'controls',
    description: 'Return a compact list of visible controls for low-token target discovery.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        selector: stringSchema('Optional CSS selector scope.'),
        filter: stringSchema('Optional visible text/name filter.'),
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum controls to return.' },
        compact: booleanSchema('Return the bounded role/label/selector/rect model. Defaults to true.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'overlay',
    description: 'Detect dialogs, overlays, and hit-test blockers for the page or a target point.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        selector: stringSchema('Optional CSS selector, @ref, or @c ref to test for coverage.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description: 'Capture a viewport screenshot for a target.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        path: stringSchema('Optional output path.'),
        annotate: booleanSchema('Overlay @ref boxes on the screenshot.'),
        confirm: booleanSchema('Required when path selects an explicit filesystem destination.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description: 'Click a selector or @ref and return action evidence. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      required: ['target', 'selector', 'confirm'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        selector: stringSchema('CSS selector, @ref, or @c ref.'),
        js: booleanSchema('Use HTMLElement.click() fallback instead of CDP mouse events.'),
        qa: booleanSchema('Return a compact QA summary instead of full action evidence.'),
        confirm: booleanSchema('Must be true to acknowledge browser-state mutation.', { const: true }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'verify_click',
    description: 'Click once and assert expected text, network request/status, and console health. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      required: ['target', 'selector', 'confirm'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        selector: stringSchema('CSS selector, @ref, or @c ref.'),
        expectText: stringSchema('Expected text after the click.'),
        expectRequest: stringSchema('Expected network request, e.g. POST /api/save.'),
        expectStatus: { type: 'integer', minimum: 100, maximum: 599, description: 'Expected HTTP status for the matched request.' },
        noConsoleErrors: booleanSchema('Fail if action console/exception errors appear.'),
        evidence: stringSchema('Text evidence detail level.', { enum: ['concise', 'full'] }),
        confirm: booleanSchema('Must be true to acknowledge browser-state mutation.', { const: true }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dismiss_modal',
    description: 'Close common dialogs/modals safely and return action evidence. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      required: ['target', 'confirm'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        confirm: booleanSchema('Must be true to acknowledge browser-state mutation.', { const: true }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'fill',
    description: 'Fill a field by selector or @ref and return action evidence. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      required: ['target', 'selector', 'text', 'confirm'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        selector: stringSchema('CSS selector or @ref.'),
        text: stringSchema('Text to enter. Sensitive values are redacted by cdp action artifacts.'),
        react: booleanSchema('Use native value setter plus input/change events.'),
        confirm: booleanSchema('Must be true to acknowledge browser-state mutation.', { const: true }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'viewport',
    description: 'Read or set viewport size. Setting size requires confirm: true.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        size: stringSchema('Optional viewport size, for example 1440x900.'),
        confirm: booleanSchema('Required when size is provided because this mutates viewport state.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'qa_page',
    description: 'Run page, console, screenshot, and optional semantic interaction QA.',
    inputSchema: {
      type: 'object',
      required: ['target', 'confirm'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        desktop: stringSchema('Desktop viewport size, for example 1440x900.'),
        mobile: stringSchema('Mobile viewport size, for example 390x844.'),
        click: stringSchema('Optional selector/ref to click as part of QA. Requires confirm: true.'),
        expectRequest: stringSchema('Expected network request, e.g. POST /api/save.'),
        expectStatus: { type: 'integer', minimum: 100, maximum: 599, description: 'Expected HTTP status for the matched request.' },
        expectText: stringSchema('Expected text after the optional action.'),
        noConsoleErrors: booleanSchema('Fail the QA report if action console/exception errors appear.'),
        confirm: booleanSchema('Must be true because QA changes viewport state and captures artifacts.', { const: true }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'responsive_audit',
    description: 'Run a bounded multi-viewport responsive visual audit with overflow/console/control signals.',
    inputSchema: {
      type: 'object',
      required: ['target', 'confirm'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        viewports: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of WxH viewports. Defaults to desktop + mobile.',
        },
        outDir: stringSchema('Optional screenshot output directory outside the repo.'),
        maxControls: { type: 'integer', minimum: 0, maximum: 100, description: 'Max visible controls sampled per viewport.' },
        confirm: booleanSchema('Must be true because the audit changes viewport state and captures artifacts.', { const: true }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'report',
    description: 'Return session action timeline, artifacts, and recovery next steps.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        last: { type: 'integer', minimum: 1, maximum: 100, description: 'Latest action count to include.' },
        all: booleanSchema('Include the full action timeline. Can be expensive.'),
        qa: booleanSchema('Return a compact QA summary instead of the full report.'),
        compact: booleanSchema('Return compact report JSON. Defaults to true unless all is requested.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'navigate',
    description: 'Navigate a target to a URL and wait for load. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      required: ['target', 'url', 'confirm'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        url: stringSchema('HTTP(S) URL to open.'),
        confirm: booleanSchema('Must be true to acknowledge browser-state mutation.', { const: true }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'press',
    description: 'Send a key press to the page. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      required: ['target', 'key', 'confirm'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        key: stringSchema('Key name, for example Enter, Escape, Tab.'),
        confirm: booleanSchema('Must be true to acknowledge browser-state mutation.', { const: true }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for',
    description: 'Wait for text, selector stability, or other waitfor conditions.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        text: stringSchema('Wait until this text appears.'),
        anyOf: stringSchema('Pipe-delimited alternatives, e.g. win|lose|escape.'),
        selectorStable: stringSchema('CSS selector that must remain stable.'),
        stableMs: { type: 'integer', minimum: 0, maximum: 120000, description: 'Stability window ms for selectorStable.' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 300000, description: 'Overall timeout ms.' },
        scope: stringSchema('Optional CSS scope selector.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cascade',
    description: 'Trace a computed CSS property back to the winning selector and source.',
    inputSchema: {
      type: 'object',
      required: ['target', 'selector'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        selector: stringSchema('CSS selector, @ref, or @c ref.'),
        property: stringSchema('CSS property to trace. Defaults to color when omitted by CLI behavior; prefer an explicit property.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'components',
    description: 'Inspect React/Vue component tree hooks when available for a selector/@ref. Requires confirm: true because props/state can contain sensitive data.',
    inputSchema: {
      type: 'object',
      required: ['target', 'confirm'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        selector: stringSchema('Optional CSS selector, @ref, or component cursor.'),
        confirm: booleanSchema('Must be true to acknowledge sensitive props/state access.', { const: true }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'spawn_debug_browser',
    description: 'Launch an isolated debug browser profile. Requires confirm: true and user consent.',
    inputSchema: {
      type: 'object',
      required: ['confirm'],
      properties: {
        browser: stringSchema('Browser id: edge, chrome, chromium, brave, vivaldi.'),
        port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Remote debugging port.' },
        url: stringSchema('Optional initial URL.'),
        headless: booleanSchema('Launch headless (CI/containers).'),
        noSandbox: booleanSchema('Pass --no-sandbox (Linux CI).'),
        confirm: booleanSchema('Must be true to acknowledge launching a browser.', { const: true }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'record_snapshot',
    description: 'Record a short temporal timeline of DOM/network/console activity.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        durationMs: { type: 'integer', minimum: 100, maximum: 120000, description: 'Recording window in ms.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'session_checkpoint',
    description: 'Capture a redacted session checkpoint for handoff/restore.',
    inputSchema: {
      type: 'object',
      required: ['target', 'confirm'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        unsafeFull: booleanSchema('Include restorable secrets. Explicit opt-in only.'),
        confirm: booleanSchema('Must be true because checkpoints read session storage and cookies.', { const: true }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'table',
    description: 'Observe a bounded table snapshot, collect a virtualized table after confirm: true, or continue a private artifact. Selector and continue are mutually exclusive; collect requires a scroll container.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        selector: stringSchema('Optional table CSS selector. Mutually exclusive with continue.'),
        collect: booleanSchema('Scroll or click to collect virtualized rows. Requires confirm: true and scrollContainer.'),
        scrollContainer: stringSchema('Virtualized scroll-container selector. Required when collect is true.'),
        loadMore: stringSchema('Optional load-more control selector. Collect-only.'),
        rowKeyColumn: { type: 'integer', minimum: 0, maximum: 255, description: 'Zero-based stable row-key column. Collect-only.' },
        continue: stringSchema('Immutable continuation token. Mutually exclusive with selector and collect.'),
        confirm: booleanSchema('Must be true for collect because collection scrolls or clicks.', { const: true }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description: 'Escape hatch: run an allowlisted chrome-cdp-ex CLI command. Mutating commands require confirm: true.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: stringSchema(`Allowlisted CLI command name. One of: ${MCP_RUN_COMMAND_ALLOWLIST.join(', ')}`),
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Positional/flag args after the command name.',
        },
        confirm: booleanSchema('Required when the command mutates state, is sensitive, raw, composite, or writes to a caller-selected destination.'),
      },
      additionalProperties: false,
    },
  },
]);

const COMMAND_SURFACE_INPUT = [
  {"name":"help","aliases":[],"needsTarget":false,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":[],"help":{"synopsis":"help","summary":"Show this command reference (same as --help)","order":0,"section":"discovery"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"list","aliases":["tabs","ls"],"needsTarget":false,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Target"],"help":{"synopsis":"list|tabs|ls [--format json]","summary":"List open pages (shows unique target prefixes)","order":1,"section":"discovery"},"mcp":{"exposure":"tool-and-run-command","toolName":"list_tabs","mapper":"list-tabs"}},
  {"name":"target","aliases":[],"needsTarget":false,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Target"],"help":{"synopsis":"target --url URL|--title TEXT [--exact] [--format json]","summary":"Select a page target by URL/title substring (or exact match).","order":2,"section":"discovery"},"mcp":{"exposure":"tool-and-run-command","toolName":"select_target","mapper":"select-target"}},
  {"name":"tab-group","aliases":["tabgroup"],"needsTarget":false,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"conditional-mutation","authorization":"conditional","evidencePolicy":"none","domains":[],"help":{"synopsis":"tab-group list|create|add|remove|delete|show [--format json]","summary":"Named multi-tab groups stored outside the repo (runtime dir).","order":3,"section":"discovery"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"broadcast","aliases":[],"needsTarget":false,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":[],"help":{"synopsis":"broadcast <group> <cmd> [args...] [--format json] [--full-results]","summary":"Run one command against every member of a tab-group.","order":4,"section":"discovery"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"open","aliases":[],"needsTarget":false,"mutates":true,"feedbackPolicy":"full-perceive","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Target","Page","Runtime"],"help":{"synopsis":"open [url] [--attach-timeout-ms N] [--ready-timeout-ms N] [--ready-selector sel] [--reuse-url] [--format json]","summary":"Open a new tab (default: about:blank)","order":77,"section":"discovery"},"mcp":{"exposure":"tool-and-run-command","toolName":"open_or_attach","mapper":"open-or-attach"}},
  {"name":"doctor","aliases":["ready"],"needsTarget":false,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Target"],"help":{"synopsis":"doctor / ready [--format json]","summary":"One-call diagnostics: Node version, skill install path,","order":75,"section":"discovery"},"mcp":{"exposure":"tool-and-run-command","toolName":"doctor","mapper":"doctor"}},
  {"name":"spawn-debug-browser","aliases":["spawn"],"needsTarget":false,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Target"],"help":{"synopsis":"spawn-debug-browser [browser] [--port N] [--url URL] [--profile-dir DIR] [--exe PATH] [--format json]","summary":"Launch an isolated debug profile (browser: edge|chrome|brave; default edge, port 9222).","order":78,"section":"discovery"},"mcp":{"exposure":"tool-and-run-command","toolName":"spawn_debug_browser","mapper":"spawn-debug-browser"}},
  {"name":"attach","aliases":[],"needsTarget":false,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"protected-mutation","authorization":"mutation","evidencePolicy":"none","domains":[],"help":{"synopsis":"attach --port N --target <id> --name <alias>","summary":"Explicitly save an alias with host/port metadata","order":6,"section":"discovery"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"use","aliases":[],"needsTarget":false,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"protected-mutation","authorization":"mutation","evidencePolicy":"none","domains":[],"help":{"synopsis":"use <target> --name <alias>","summary":"Save a named target alias (also becomes current)","order":5,"section":"discovery"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"forget","aliases":[],"needsTarget":false,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"protected-mutation","authorization":"mutation","evidencePolicy":"none","domains":[],"help":{"synopsis":"forget <alias>","summary":"Remove a saved alias","order":8,"section":"discovery"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"current","aliases":[],"needsTarget":false,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":[],"help":{"synopsis":"current [--format json]","summary":"Show current alias plus saved aliases","order":7,"section":"discovery"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"stop","aliases":[],"needsTarget":false,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":[],"help":{"synopsis":"stop [target] [--format json]","summary":"Stop daemon(s) and report stopped targets, remaining sessions, or explicit no-op","order":80,"section":"discovery"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"perceive","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Accessibility","DOM","Runtime"],"help":{"synopsis":"perceive <target> [flags] [--format json]","summary":"Full page perception with @ref indices + coordinates","order":9,"section":"observation"},"mcp":{"exposure":"tool-and-run-command","toolName":"perceive","mapper":"perceive"}},
  {"name":"snap","aliases":["snapshot"],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Accessibility"],"help":{"synopsis":"snap <target> [--full]","summary":"Accessibility tree snapshot (compact by default, --full for complete)","order":10,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"controls","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Runtime"],"help":{"synopsis":"controls <target> [-s selector] [--filter text] [--limit N] [--compact] [--format json]","summary":"Bounded visible controls inventory for selector/debugging repair","order":11,"section":"observation"},"mcp":{"exposure":"tool-and-run-command","toolName":"controls","mapper":"controls"}},
  {"name":"eval","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"script","authorization":"raw-script","evidencePolicy":"none","domains":["Runtime"],"help":{"synopsis":"eval <target> <expr>","summary":"Evaluate JS expression","order":12,"section":"workflow"},"mcp":{"exposure":"none","toolName":null,"mapper":null}},
  {"name":"eval64","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"script","authorization":"raw-script","evidencePolicy":"none","domains":["Runtime"],"help":{"synopsis":"eval64 <target> <base64>","summary":"Shorthand for eval --b64; preserves multibyte characters","order":13,"section":"workflow"},"mcp":{"exposure":"none","toolName":null,"mapper":null}},
  {"name":"call","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"script","authorization":"raw-script","evidencePolicy":"none","domains":["Runtime"],"help":{"synopsis":"call <target> <expr|fn>","summary":"Await expression/function result and print JSON when possible","order":14,"section":"workflow"},"mcp":{"exposure":"none","toolName":null,"mapper":null}},
  {"name":"wait","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":[],"help":{"synopsis":"wait <target> <ms>","summary":"Delay inside cdp (also: cdp wait <ms> [target])","order":47,"section":"workflow"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"keepalive","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"protected-mutation","authorization":"mutation","evidencePolicy":"none","domains":["Runtime"],"help":{"synopsis":"keepalive <target> <ms>","summary":"Extend this tab daemon lifetime (fire-and-forget eval extends 1h)","order":76,"section":"workflow"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"shot","aliases":["screenshot"],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"conditional-mutation","authorization":"conditional","evidencePolicy":"none","domains":["Page","Runtime"],"help":{"synopsis":"shot <target> [file|--annotate]","summary":"Viewport screenshot; --annotate (-a) overlays @ref labels","order":16,"section":"observation"},"mcp":{"exposure":"tool-and-run-command","toolName":"screenshot","mapper":"screenshot"}},
  {"name":"diff-shot","aliases":["diffshot"],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"conditional-mutation","authorization":"conditional","evidencePolicy":"none","domains":["Page","Runtime"],"help":{"synopsis":"diff-shot <target> [--reset] [--threshold pct]","summary":"Compare current screenshot against last diff-shot baseline","order":17,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"html","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Runtime"],"help":{"synopsis":"html <target> [selector]","summary":"Get HTML (full page or CSS selector)","order":18,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"nav","aliases":["navigate"],"needsTarget":true,"mutates":true,"feedbackPolicy":"full-perceive","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Page","Runtime"],"help":{"synopsis":"nav <target> <url> [--format json]","summary":"Navigate to URL and wait for load completion","order":19,"section":"interaction"},"mcp":{"exposure":"tool-and-run-command","toolName":"navigate","mapper":"navigate"}},
  {"name":"net","aliases":["network"],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Runtime"],"help":{"synopsis":"net <target>","summary":"Network performance entries","order":37,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"mock","aliases":["network-mock"],"needsTarget":true,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Fetch"],"help":{"synopsis":"mock <target> [add|clear]","summary":"Mock matching network requests in this live tab","order":20,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"clock","aliases":["time-travel"],"needsTarget":true,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Page","Runtime"],"help":{"synopsis":"clock <target> [freeze|offset|reset]","summary":"Override Date/time in this live tab","order":21,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"throttle","aliases":["network-throttle"],"needsTarget":true,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Network"],"help":{"synopsis":"throttle <target> [off|offline|slow-3g|fast-3g|lte|custom]","summary":"Emulate network conditions for this tab","order":22,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"status","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Runtime","Performance"],"help":{"synopsis":"status <target> [--runtime]","summary":"Page state + new console/exception entries (primary debug entry point)","order":23,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"console","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"conditional-mutation","authorization":"conditional","evidencePolicy":"none","domains":[],"help":{"synopsis":"console <target> [--all|--errors|--clear]","summary":"Console buffer (default: new entries only; --clear: reset console+exception baseline)","order":24,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"summary","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Runtime"],"help":{"synopsis":"summary <target>","summary":"Token-efficient page overview (interactive elements, scroll, console health)","order":25,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"frame","aliases":["frames"],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Page","DOM","Runtime"],"help":{"synopsis":"frame <target> [--format json]","summary":"List page frames with stable @fN refs (alias: frames)","order":32,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"overlay","aliases":["overlays"],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Runtime"],"help":{"synopsis":"overlay <target> [sel|@ref] [--format json]","summary":"Detect visible dialogs/overlays and target blockers","order":33,"section":"observation"},"mcp":{"exposure":"tool-and-run-command","toolName":"overlay","mapper":"overlay"}},
  {"name":"report","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"evidence","authorization":"standard","evidencePolicy":"session-report","domains":[],"help":{"synopsis":"report <target> [--last N|--all] [--format json] [--qa|--summary] [--compact]","summary":"Session action timeline + evidence summary + JSONL log path","order":26,"section":"observation"},"mcp":{"exposure":"tool-and-run-command","toolName":"report","mapper":"report"}},
  {"name":"checkpoint","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"sensitive-read","authorization":"sensitive-read","evidencePolicy":"none","domains":["Network","Runtime"],"help":{"synopsis":"checkpoint <target> [--unsafe-full] [--format json]","summary":"Capture URL plus redacted cookies/storage; unsafe-full keeps restorable secrets","order":27,"section":"workflow"},"mcp":{"exposure":"tool-and-run-command","toolName":"session_checkpoint","mapper":"session-checkpoint"}},
  {"name":"restore","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Page","Network","Runtime"],"help":{"synopsis":"restore <target> --file <path> [--format json]","summary":"Restore a checkpoint artifact into the live page","order":28,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"record-actions","aliases":["recordactions"],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":[],"help":{"synopsis":"record-actions <target>","summary":"Export action log + mock/clock/throttle environment as text or JSON","order":29,"section":"workflow"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"export-playwright","aliases":["export-pw"],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":[],"help":{"synopsis":"export-playwright <target> [--format json]","summary":"Export current workflow as a Playwright spec draft or JSON handoff","order":30,"section":"workflow"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"replay","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Page","Network","Runtime","Input","Emulation","Fetch"],"help":{"synopsis":"replay <target> --file <path> [--format json]","summary":"Replay environment controls + actions against the live page","order":31,"section":"interaction"},"mcp":{"exposure":"none","toolName":null,"mapper":null}},
  {"name":"elshot","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["DOM","Page","Runtime"],"help":{"synopsis":"elshot <target> <sel|@ref>","summary":"Element screenshot: captures element by CSS selector or @ref","order":15,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"qa","aliases":["qa-page"],"needsTarget":true,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Accessibility","DOM","Runtime","Page","Input","Network","Emulation"],"help":{"synopsis":"qa <target> [--desktop WxH] [--mobile WxH] [--format json]","summary":"Live UI smoke: page info, console health, screenshots, perception, assertions","order":34,"section":"interaction"},"mcp":{"exposure":"tool-and-run-command","toolName":"qa_page","mapper":"qa-page"}},
  {"name":"responsive-audit","aliases":["visual-check"],"needsTarget":true,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Accessibility","DOM","Runtime","Page","Emulation"],"help":{"synopsis":"responsive-audit <target> [--viewport WxH ...] [--out-dir DIR] [--format json]","summary":"Built-in responsive visual audit (alias: visual-check).","order":35,"section":"interaction"},"mcp":{"exposure":"tool-and-run-command","toolName":"responsive_audit","mapper":"responsive-audit"}},
  {"name":"verify-click","aliases":["verifyclick"],"needsTarget":true,"mutates":true,"feedbackPolicy":"settle-diff","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["DOM","Runtime","Input","Network"],"help":{"synopsis":"verify-click <target> <sel|@ref> [--format json]","summary":"Click once and assert text/network/console outcomes","order":36,"section":"interaction"},"mcp":{"exposure":"tool-and-run-command","toolName":"verify_click","mapper":"verify-click"}},
  {"name":"click","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"settle-diff","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["DOM","Runtime","Input"],"help":{"synopsis":"click <target> <sel|@ref> [--format json] [--qa|--summary]","summary":"Click element by CSS selector or @ref","order":38,"section":"interaction"},"mcp":{"exposure":"tool-and-run-command","toolName":"click","mapper":"click"}},
  {"name":"jsclick","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"settle-diff","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["DOM","Runtime"],"help":{"synopsis":"jsclick <target> <sel|@ref>","summary":"JS-only click: el.click() instead of CDP mouse events","order":39,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"clickxy","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"settle-diff","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Input"],"help":{"synopsis":"clickxy <target> <x> <y> [--format json]","summary":"Click at CSS pixel coordinates (see coordinate note below)","order":40,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"type","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"settle-diff","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Input"],"help":{"synopsis":"type <target> <text> [--format json]","summary":"Type text at current focus via Input.insertText","order":41,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"press","aliases":["key"],"needsTarget":true,"mutates":true,"feedbackPolicy":"settle-diff","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Input"],"help":{"synopsis":"press|key <target> <key> [--format json]","summary":"Press key (Enter, Tab, Escape, Backspace, Space, Arrow*)","order":42,"section":"interaction"},"mcp":{"exposure":"tool-and-run-command","toolName":"press","mapper":"press"}},
  {"name":"scroll","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"settle-diff","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Runtime"],"help":{"synopsis":"scroll <target> <dir|x,y> [px] [--format json]","summary":"Scroll page (down/up/left/right or x,y offset; default 500px)","order":43,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"hover","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"protected-mutation","authorization":"mutation","evidencePolicy":"none","domains":["DOM","Runtime","Input"],"help":{"synopsis":"hover <target> <sel|@ref>","summary":"Hover over element (triggers :hover, tooltips, dropdowns)","order":44,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"waitfor","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["DOM","Runtime"],"help":{"synopsis":"waitfor <target> <selector> [ms]","summary":"Wait for element (default 10s, max 5min)","order":45,"section":"workflow"},"mcp":{"exposure":"tool-and-run-command","toolName":"wait_for","mapper":"wait-for"}},
  {"name":"loadall","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"protected-mutation","authorization":"mutation","evidencePolicy":"none","domains":["DOM","Runtime","Input"],"help":{"synopsis":"loadall <target> <selector> [ms]","summary":"Repeatedly click a \"load more\" button until it disappears","order":46,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"fill","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"settle-diff","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["DOM","Runtime","Input"],"help":{"synopsis":"fill <target> <sel|@ref> <txt> [--format json]","summary":"Clear field and type text (for form filling)","order":48,"section":"interaction"},"mcp":{"exposure":"tool-and-run-command","toolName":"fill","mapper":"fill"}},
  {"name":"select","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"settle-diff","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Runtime"],"help":{"synopsis":"select <target> <selector> <val> [--format json]","summary":"Select an option in a <select> element by value","order":49,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"fullshot","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"conditional-mutation","authorization":"conditional","evidencePolicy":"none","domains":["Page","Runtime"],"help":{"synopsis":"fullshot <target> [file]","summary":"Full-page screenshot (single image — may be hard to read)","order":50,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"scanshot","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Page","Runtime"],"help":{"synopsis":"scanshot <target>","summary":"Segmented full-page capture (viewport-sized images, readable)","order":51,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"styles","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Runtime"],"help":{"synopsis":"styles <target> <selector> [--root auto|body|document|<sel>]","summary":"Get computed styles for element (filtered to meaningful props)","order":52,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"components","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"sensitive-read","authorization":"sensitive-read","evidencePolicy":"none","domains":["DOM","Runtime"],"help":{"synopsis":"components <target> [--depth N] [@ref|selector] [--max-chars N] [--unsafe-full] [--format json]","summary":"React/Vue component tree; targeted props/state requires React fiber.","order":53,"section":"observation"},"mcp":{"exposure":"tool-and-run-command","toolName":"components","mapper":"components"}},
  {"name":"cookies","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"sensitive-read","authorization":"sensitive-read","evidencePolicy":"none","domains":["Network"],"help":{"synopsis":"cookies <target>","summary":"List cookies for current page","order":54,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"cookieset","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Network"],"help":{"synopsis":"cookieset <target> <cookie>","summary":"Set a cookie: \"name=value\" or \"name=value; domain=.example.com; secure\"","order":55,"section":"interaction"},"mcp":{"exposure":"none","toolName":null,"mapper":null}},
  {"name":"cookiedel","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Network"],"help":{"synopsis":"cookiedel <target> <name>","summary":"Delete a cookie by name","order":56,"section":"interaction"},"mcp":{"exposure":"none","toolName":null,"mapper":null}},
  {"name":"evalraw","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"raw-cdp","authorization":"raw-cdp","evidencePolicy":"raw-audit","domains":[],"help":{"synopsis":"evalraw <target> <method> [json]","summary":"Send a raw CDP command; returns JSON result","order":71,"section":"workflow"},"mcp":{"exposure":"none","toolName":null,"mapper":null}},
  {"name":"batch","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"composite","authorization":"composite","evidencePolicy":"none","domains":[],"help":{"synopsis":"batch <target> <cmds> [--parallel] [--format json]","summary":"Execute multiple commands in one call","order":72,"section":"workflow"},"mcp":{"exposure":"none","toolName":null,"mapper":null}},
  {"name":"dialog","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"protected-mutation","authorization":"mutation","evidencePolicy":"none","domains":["Page"],"help":{"synopsis":"dialog <target> [accept|dismiss]","summary":"Show dialog history; set auto-accept (default) or auto-dismiss","order":57,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"viewport","aliases":["resize"],"needsTarget":true,"mutates":true,"feedbackPolicy":"settle-diff","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Emulation","Runtime","Page"],"help":{"synopsis":"viewport|resize <target> [WxH]","summary":"Show or set viewport size (e.g. 375x812, 1280x720)","order":58,"section":"interaction"},"mcp":{"exposure":"tool-and-run-command","toolName":"viewport","mapper":"viewport"}},
  {"name":"emulate","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Emulation"],"help":{"synopsis":"emulate <target> [dark|light|no-preference|off|status]","summary":"Media feature emulation via CDP Emulation.setEmulatedMedia","order":59,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"upload","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"state-change","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["DOM"],"help":{"synopsis":"upload <target> <selector> <paths> [--format json]","summary":"Upload file(s) to <input type=\"file\"> (comma-separated paths)","order":60,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"text","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["Runtime"],"help":{"synopsis":"text <target> [selector]","summary":"Clean visible text — optional CSS selector to scope","order":61,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"table","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"conditional-mutation","authorization":"conditional","evidencePolicy":"none","domains":["Runtime"],"help":{"synopsis":"table <target> [TABLE_SELECTOR] [--format text|json] | table <target> [TABLE_SELECTOR] --collect --scroll-container SELECTOR [--load-more SELECTOR] [--row-key-column N] [--format text|json] | table <target> --continue TOKEN --format json","summary":"Bounded table observation with completeness, explicit virtual collection, and private continuation; fixed ceilings and MCP collect confirmation","order":62,"section":"observation"},"mcp":{"exposure":"tool-and-run-command","toolName":"table","mapper":"table"}},
  {"name":"back","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"full-perceive","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Page","Runtime"],"help":{"synopsis":"back <target>","summary":"Navigate back in browser history","order":63,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"forward","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"full-perceive","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Page","Runtime"],"help":{"synopsis":"forward <target>","summary":"Navigate forward in browser history","order":64,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"reload","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"state-change","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Page","Runtime"],"help":{"synopsis":"reload <target>","summary":"Reload current page and clear console/exception/navigation buffers","order":65,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"closetab","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"report-only","outputFormats":["text"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Target"],"help":{"synopsis":"closetab <target>","summary":"Close a browser tab","order":66,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"netlog","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"conditional-mutation","authorization":"conditional","evidencePolicy":"none","domains":[],"help":{"synopsis":"netlog <target> [--clear]","summary":"Network request log (XHR/Fetch/Document with status + timing)","order":67,"section":"observation"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"inject","aliases":[],"needsTarget":true,"mutates":true,"feedbackPolicy":"state-change","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["Runtime"],"help":{"synopsis":"inject <target> <flag> [content]","summary":"Live CSS/JS injection with tracking and removal","order":68,"section":"interaction"},"mcp":{"exposure":"run-command","toolName":null,"mapper":null}},
  {"name":"cascade","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"read","authorization":"standard","evidencePolicy":"none","domains":["DOM","CSS"],"help":{"synopsis":"cascade <target> <sel|@ref> [prop] [--format json]","summary":"CSS origin tracing — shows which rules apply, source file + line","order":69,"section":"observation"},"mcp":{"exposure":"tool-and-run-command","toolName":"cascade","mapper":"cascade"}},
  {"name":"record","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"conditional-mutation","authorization":"conditional","evidencePolicy":"none","domains":["DOM","Runtime","Page"],"help":{"synopsis":"record <target> [ms]","summary":"Record a short timeline of DOM/console/network/navigation events","order":70,"section":"observation"},"mcp":{"exposure":"tool-and-run-command","toolName":"record_snapshot","mapper":"record-snapshot"}},
  {"name":"flow","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text","json"],"feedbackPolicy":null,"kind":"composite","authorization":"composite","evidencePolicy":"none","domains":[],"help":{"synopsis":"flow <target> \"<steps>\" [--format json]","summary":"Sequential runner. Steps separated by \";\".","order":73,"section":"workflow"},"mcp":{"exposure":"none","toolName":null,"mapper":null}},
  {"name":"repeat","aliases":[],"needsTarget":true,"mutates":false,"outputFormats":["text"],"feedbackPolicy":null,"kind":"composite","authorization":"composite","evidencePolicy":"none","domains":[],"help":{"synopsis":"repeat <target> <N> <cmd> [args]","summary":"Run a command up to N times (cap 50). Fail-fast exits non-zero.","order":74,"section":"workflow"},"mcp":{"exposure":"none","toolName":null,"mapper":null}},
  {"name":"dismiss-modal","aliases":["dismissmodal"],"needsTarget":true,"mutates":true,"feedbackPolicy":"settle-diff","outputFormats":["text","json"],"kind":"mutation","authorization":"mutation","evidencePolicy":"action-receipt","domains":["DOM","Runtime","Input"],"help":{"synopsis":"dismiss-modal <target>","summary":"Close common dialog/modal patterns safely (close button, then Escape) —","order":79,"section":"interaction"},"mcp":{"exposure":"tool-and-run-command","toolName":"dismiss_modal","mapper":"dismiss-modal"}}
];

export const COMMAND_SURFACE = defineCommandSurface(COMMAND_SURFACE_INPUT);
export const COMMAND_SURFACE_RECORDS = COMMAND_SURFACE.commands;

const VALIDATED_MCP_SURFACE = defineMcpSurface({
  tools: MCP_TOOL_DEFINITIONS,
  resources: MCP_RESOURCE_RECORDS_INPUT,
  runCommandAllowlist: MCP_RUN_COMMAND_ALLOWLIST,
});
deepFreezeTrustedData(MCP_TOOL_DEFINITIONS);
deepFreezeTrustedData(MCP_RESOURCE_TEMPLATES);
deepFreezeTrustedData(MCP_RUN_COMMAND_ALLOWLIST);

function validateSurfaceConsistency(commandSurface, mcpSurface) {
  if (mcpSurface.tools.filter(tool => tool.name === 'run_command').length !== 1) {
    fail('mcp.tools', 'must contain exactly one run_command escape hatch');
  }
  const commandToolNames = commandSurface.commands
    .map(command => command.mcp.toolName)
    .filter(Boolean);
  const declaredToolNames = mcpSurface.tools
    .map(tool => tool.name)
    .filter(name => name !== 'run_command');
  if (commandToolNames.length !== new Set(commandToolNames).size) fail('commands', 'contains duplicate MCP tool ownership');
  if (commandToolNames.length !== declaredToolNames.length
      || commandToolNames.some(name => !declaredToolNames.includes(name))) {
    fail('mcp.tools', 'must exactly match command-owned first-class tools plus run_command');
  }
  const mapperOwners = new Set();
  for (const command of commandSurface.commands.filter(candidate => candidate.mcp.toolName)) {
    if (mapperOwners.has(command.mcp.mapper)) fail('commands', `duplicate MCP mapper ownership for ${command.mcp.mapper}`);
    mapperOwners.add(command.mcp.mapper);
  }
  for (const resource of mcpSurface.resources) {
    if (resource.mapper !== resource.name) fail(`mcp.resources.${resource.name}.mapper`, 'must match its reviewed resource identity');
  }

  const declaredAllowlist = new Set(mcpSurface.runCommandAllowlist);
  for (const spelling of declaredAllowlist) {
    const command = commandSurface.resolve(spelling);
    if (!command || (command.mcp.exposure !== 'run-command' && command.mcp.exposure !== 'tool-and-run-command')) {
      fail('mcp.runCommandAllowlist', `contains unexposed spelling ${spelling}`);
    }
  }
  for (const command of commandSurface.commands) {
    if ((command.mcp.exposure === 'run-command' || command.mcp.exposure === 'tool-and-run-command')
        && !declaredAllowlist.has(command.name)) {
      fail('mcp.runCommandAllowlist', `is missing canonical command ${command.name}`);
    }
  }
}

validateSurfaceConsistency(COMMAND_SURFACE, VALIDATED_MCP_SURFACE);

export const MCP_RESOURCE_RECORDS = VALIDATED_MCP_SURFACE.resources;
export const MCP_TOOL_MAPPER_BY_NAME = Object.freeze(Object.fromEntries([
  ...COMMAND_SURFACE.commands
    .filter(command => command.mcp.toolName)
    .map(command => [command.mcp.toolName, command.mcp.mapper]),
  ['run_command', 'run-command'],
]));

export const MCP_SURFACE = Object.freeze({
  tools: MCP_TOOL_DEFINITIONS,
  resources: MCP_RESOURCE_RECORDS,
  runCommandAllowlist: MCP_RUN_COMMAND_ALLOWLIST,
});

function surfaceDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export const COMMAND_SURFACE_IDENTITY = 'ed09a707e1c2094b56d45db13e26f4c6277b52872abea9d99fdab12059f32f15';
export const MCP_SURFACE_IDENTITY = '587d24c865caf41cca9b0a0553d254612bd7c8976edb37b0a9d4e0bff0978733';
if (surfaceDigest(COMMAND_SURFACE.commands) !== COMMAND_SURFACE_IDENTITY) {
  fail('commands', `reviewed catalog identity drifted (${surfaceDigest(COMMAND_SURFACE.commands)})`);
}
if (surfaceDigest(MCP_SURFACE) !== MCP_SURFACE_IDENTITY) {
  fail('mcp', `reviewed catalog identity drifted (${surfaceDigest(MCP_SURFACE)})`);
}

export function projectCliCommands(surface = COMMAND_SURFACE) {
  return Object.freeze(surface.commands.map(command => Object.freeze({
    name: command.name,
    aliases: command.aliases,
    needsTarget: command.needsTarget,
    mutates: command.mutates,
    ...(command.feedbackPolicy === null ? {} : { feedbackPolicy: command.feedbackPolicy }),
    outputFormats: command.outputFormats,
  })));
}
