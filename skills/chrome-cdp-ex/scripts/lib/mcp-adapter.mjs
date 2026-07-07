import { readFileSync } from 'fs';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
).version;

function stringSchema(description, extra = {}) {
  return { type: 'string', description, ...extra };
}

function booleanSchema(description, extra = {}) {
  return { type: 'boolean', description, ...extra };
}

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
        confirm: booleanSchema('Required when opening a new tab because this mutates browser state.'),
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
      required: ['target'],
      properties: {
        target: stringSchema('Target prefix or named alias.'),
        desktop: stringSchema('Desktop viewport size, for example 1440x900.'),
        mobile: stringSchema('Mobile viewport size, for example 390x844.'),
        click: stringSchema('Optional selector/ref to click as part of QA. Requires confirm: true.'),
        expectRequest: stringSchema('Expected network request, e.g. POST /api/save.'),
        expectStatus: { type: 'integer', minimum: 100, maximum: 599, description: 'Expected HTTP status for the matched request.' },
        expectText: stringSchema('Expected text after the optional action.'),
        noConsoleErrors: booleanSchema('Fail the QA report if action console/exception errors appear.'),
        confirm: booleanSchema('Required when click is provided because this mutates browser state.'),
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
      },
      additionalProperties: false,
    },
  },
]);

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

export function buildMcpToolCommand(name, args = {}) {
  switch (name) {
    case 'doctor':
      return ['doctor', '--format', 'json'];
    case 'list_tabs':
      return ['list', '--format', 'json'];
    case 'open_or_attach': {
      if (args.target || args.name || args.port) {
        const command = ['use'];
        if (args.port) command.push('--port', String(args.port));
        if (args.target) command.push('--target', String(args.target));
        if (args.name) command.push('--name', String(args.name));
        return command;
      }
      requireConfirm(args, 'open_or_attach');
      return ['open', args.url || 'about:blank', '--format', 'json'];
    }
    case 'perceive': {
      const command = ['perceive', requireString(args, 'target')];
      if (args.depth != null) command.push('-d', String(args.depth));
      if (args.cursorInteractive) command.push('-C');
      if (args.selector) command.push('--selector', String(args.selector));
      if (args.sinceAction) command.push('--since-action');
      return optionalFormatJson(command);
    }
    case 'controls': {
      const command = ['controls', requireString(args, 'target')];
      if (args.selector) command.push('--selector', String(args.selector));
      if (args.filter) command.push('--filter', String(args.filter));
      if (args.limit != null) command.push('--limit', String(args.limit));
      return optionalFormatJson(command);
    }
    case 'overlay': {
      const command = ['overlay', requireString(args, 'target')];
      if (args.selector) command.push(String(args.selector));
      return optionalFormatJson(command);
    }
    case 'screenshot': {
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
      return optionalFormatJson(command);
    }
    case 'verify_click': {
      requireConfirm(args, 'verify_click');
      const command = ['verify-click', requireString(args, 'target'), requireString(args, 'selector')];
      if (args.expectText) command.push('--expect-text', String(args.expectText));
      if (args.expectRequest) command.push('--expect-request', String(args.expectRequest));
      if (args.expectStatus != null) command.push('--expect-status', String(args.expectStatus));
      if (args.noConsoleErrors) command.push('--no-console-errors');
      if (args.evidence) command.push('--evidence', String(args.evidence));
      return optionalFormatJson(command);
    }
    case 'dismiss_modal': {
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
    case 'qa_page': {
      if (args.click) requireConfirm(args, 'qa_page click');
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
    case 'report': {
      const command = ['report', requireString(args, 'target')];
      if (args.all) command.push('--all');
      else if (args.last != null) command.push('--last', String(args.last));
      return optionalFormatJson(command);
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
    },
  };
}
