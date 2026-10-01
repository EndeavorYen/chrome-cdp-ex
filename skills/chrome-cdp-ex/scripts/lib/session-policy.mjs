// Opt-in session guardrails (#466): page-content boundaries, an origin allowlist and an action
// deny-list. Every one is off unless its environment variable is set, and with none set the
// runtime sends, runs and prints exactly what it did before.
//
// This is defense-in-depth for agents, not a security boundary. Page JavaScript still runs; a
// click, key press or page script can still reach a disallowed origin (the check runs after the
// command and reports it); and nothing here stops the user or another tool from driving the
// browser.
//
// The CLI reads the variables on every run and sends the parsed policy with each daemon request,
// so a tab daemon started earlier, under other variables, still applies the current policy.
import { randomBytes } from 'crypto';
import { COMMAND_SURFACE } from './command-surface.mjs';

export const POLICY_ENV_VARS = Object.freeze({
  contentBoundaries: 'CDP_CONTENT_BOUNDARIES',
  allowedOrigins: 'CDP_ALLOWED_ORIGINS',
  denyActions: 'CDP_DENY_ACTIONS',
});

// Commands whose output is page-derived text and gets wrapped under CDP_CONTENT_BOUNDARIES=1.
export const CONTENT_BOUNDARY_COMMANDS = Object.freeze(['perceive', 'text', 'console', 'table', 'netlog']);

// Steps inside these commands are checked before the first step runs.
export const POLICY_COMPOSITE_COMMANDS = Object.freeze(['batch', 'flow', 'repeat', 'replay']);

const POLICY_PREFIX = 'policy: ';
const POLICY_CONFIG_PREFIX = 'policy config: ';
const MAX_POLICY_ENTRIES = 64;
const MAX_URL_DISPLAY_CHARS = 200;
const MAX_COMPOSITE_DEPTH = 3;
const POLICY_WIRE_KEYS = new Set(['denyActions', 'allowedOrigins', 'contentBoundary']);
const CONTENT_BOUNDARY_NONCE_RE = /^[0-9a-f]{16}$/;

function policyConfigError(message) {
  const error = new Error(`${POLICY_CONFIG_PREFIX}${message}`);
  error.code = 'policy_config';
  return error;
}

function readSwitch(env, name) {
  const raw = String(env?.[name] ?? '').trim();
  if (!raw || /^(0|false|no|off)$/i.test(raw)) return false;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  throw policyConfigError(`${name}=${raw} is not a switch; set it to 1 to turn it on, or unset it.`);
}

function readList(env, name) {
  const entries = String(env?.[name] ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  if (entries.length > MAX_POLICY_ENTRIES) {
    throw policyConfigError(`${name} lists ${entries.length} entries; at most ${MAX_POLICY_ENTRIES} are allowed.`);
  }
  return entries;
}

function badOrigin(text) {
  return policyConfigError(
    `CDP_ALLOWED_ORIGINS entry "${text}" is not an origin. Write scheme://host[:port] `
    + '(https://app.example.com, http://localhost:3000) or scheme://*.host for its subdomains (https://*.example.com).',
  );
}

// `https://app.example.com`, `http://localhost:3000`, `https://*.example.com` (subdomains only,
// not example.com itself), `file://` (any file: URL). No path, query or fragment.
export function parseOriginPattern(raw) {
  const text = String(raw ?? '').trim();
  const match = /^([a-z][a-z0-9+.-]*):\/\/(\*\.)?(.*)$/i.exec(text);
  if (!match) throw badOrigin(text);
  const [, scheme, wildcard, rest] = match;
  if (wildcard && !rest) throw badOrigin(text);
  let parsed;
  try {
    parsed = new URL(`${scheme}://${rest}`);
  } catch {
    throw badOrigin(text);
  }
  const hasPath = parsed.pathname && parsed.pathname !== '/';
  if (hasPath || parsed.search || parsed.hash || parsed.username || parsed.password
    || parsed.hostname.includes('*') || (wildcard && !parsed.hostname)) {
    throw badOrigin(text);
  }
  return Object.freeze({
    source: text,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    wildcard: Boolean(wildcard),
  });
}

function resolveDenyAction(name, surface) {
  const command = surface.resolve(name) || surface.resolve(String(name).toLowerCase());
  if (!command) {
    throw policyConfigError(`CDP_DENY_ACTIONS names "${name}", which is not a command. Use names from \`cdp help\` (e.g. eval,cookieset,upload).`);
  }
  return command.name;
}

function freezePolicy({ contentBoundaries = false, allowedOrigins = null, denyActions = null }) {
  if (!contentBoundaries && !allowedOrigins && !denyActions) return null;
  return Object.freeze({
    contentBoundaries: Boolean(contentBoundaries),
    allowedOrigins: allowedOrigins ? Object.freeze(allowedOrigins) : null,
    denyActions: denyActions ? Object.freeze([...new Set(denyActions)]) : null,
  });
}

// Null when no variable is set. Throws a `policy config:` error for a value it cannot use, so a
// typo never silently turns a guardrail off.
export function readSessionPolicy(env = process.env, { surface = COMMAND_SURFACE } = {}) {
  const contentBoundaries = readSwitch(env, POLICY_ENV_VARS.contentBoundaries);
  const origins = readList(env, POLICY_ENV_VARS.allowedOrigins);
  const denies = readList(env, POLICY_ENV_VARS.denyActions);
  return freezePolicy({
    contentBoundaries,
    allowedOrigins: origins.length ? origins.map(parseOriginPattern) : null,
    denyActions: denies.length ? denies.map(name => resolveDenyAction(name, surface)) : null,
  });
}

export function canonicalPolicyCommand(cmd, surface = COMMAND_SURFACE) {
  return surface.resolve(String(cmd || ''))?.name || String(cmd || '');
}

// The `policy` field of a daemon request. `{}` (no field at all) when no policy is set, so the
// request line is byte-identical to the one sent without guardrails.
export function policyRequestFields(policy, cmd, { contentBoundary = true } = {}) {
  if (!policy) return {};
  const wire = {};
  if (policy.denyActions) wire.denyActions = [...policy.denyActions];
  if (policy.allowedOrigins) wire.allowedOrigins = policy.allowedOrigins.map(pattern => pattern.source);
  if (contentBoundary && policy.contentBoundaries
    && CONTENT_BOUNDARY_COMMANDS.includes(canonicalPolicyCommand(cmd))) {
    wire.contentBoundary = true;
  }
  return Object.keys(wire).length ? { policy: wire } : {};
}

function stringList(value, path) {
  if (!Array.isArray(value) || value.length > MAX_POLICY_ENTRIES || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`${path} must be an array of at most ${MAX_POLICY_ENTRIES} strings`);
  }
  return [...value];
}

// Daemon side: validate and parse the `policy` field of a request.
export function parsePolicyWire(input, { surface = COMMAND_SURFACE } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('daemon request.policy must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!POLICY_WIRE_KEYS.has(key)) throw new Error(`daemon request.policy.${key}: is not allowed`);
  }
  if (Object.hasOwn(input, 'contentBoundary') && typeof input.contentBoundary !== 'boolean') {
    throw new Error('daemon request.policy.contentBoundary must be a boolean');
  }
  const origins = Object.hasOwn(input, 'allowedOrigins') ? stringList(input.allowedOrigins, 'daemon request.policy.allowedOrigins') : [];
  const denies = Object.hasOwn(input, 'denyActions') ? stringList(input.denyActions, 'daemon request.policy.denyActions') : [];
  const policy = freezePolicy({
    allowedOrigins: origins.length ? origins.map(parseOriginPattern) : null,
    denyActions: denies.length ? denies.map(name => resolveDenyAction(name, surface)) : null,
  });
  return Object.freeze({
    denyActions: policy?.denyActions || null,
    allowedOrigins: policy?.allowedOrigins || null,
    contentBoundary: input.contentBoundary === true,
  });
}

export function snapshotPolicyWire(input) {
  const policy = parsePolicyWire(input);
  const wire = {};
  if (policy.denyActions) wire.denyActions = Object.freeze([...policy.denyActions]);
  if (policy.allowedOrigins) wire.allowedOrigins = Object.freeze(policy.allowedOrigins.map(pattern => pattern.source));
  if (policy.contentBoundary) wire.contentBoundary = true;
  return Object.freeze(wire);
}

// --- origins --------------------------------------------------------------------------------

function parseUrl(url) {
  try {
    return new URL(String(url ?? ''));
  } catch {
    return null;
  }
}

// Pages that belong to no site: a blank or srcdoc document, or Chrome's own error page for a
// navigation that failed. They are never a policy violation.
export function isPolicyNeutralUrl(url) {
  const text = String(url ?? '').trim();
  return !text || /^about:(blank|srcdoc)([?#].*)?$/i.test(text) || /^chrome-error:/i.test(text);
}

export function originMatches(url, patterns = []) {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLowerCase();
  return patterns.some(pattern => parsed.protocol === pattern.protocol
    && parsed.port === pattern.port
    && (pattern.wildcard ? hostname.endsWith(`.${pattern.hostname}`) : hostname === pattern.hostname));
}

export function navigationAllowed(url, patterns) {
  if (!patterns) return true;
  return isPolicyNeutralUrl(url) || originMatches(url, patterns);
}

// A short label for where page content came from: `https://app.example.com`, `file://`,
// `about:blank`, or `unknown`.
export function originLabel(url) {
  const parsed = parseUrl(url);
  if (!parsed) return 'unknown';
  if (parsed.origin && parsed.origin !== 'null') return parsed.origin;
  if (parsed.protocol === 'file:') return 'file://';
  if (parsed.protocol === 'about:') return `about:${parsed.pathname}`;
  return parsed.protocol || 'unknown';
}

// Origin and path only: a query or fragment can carry a token.
export function displayPolicyUrl(url) {
  const parsed = parseUrl(url);
  const text = parsed
    ? (parsed.origin && parsed.origin !== 'null' ? `${parsed.origin}${parsed.pathname}` : `${parsed.protocol}${parsed.pathname}`)
    : String(url ?? '').split(/[?#]/)[0];
  const oneLine = text.replace(/\s+/g, '');
  return oneLine.length > MAX_URL_DISPLAY_CHARS ? `${oneLine.slice(0, MAX_URL_DISPLAY_CHARS - 1)}…` : oneLine;
}

// Every token of `nav <target> ...` (target removed) that parses as a URL. A flag value such as
// `--max-diff-lines 5` never does, so it cannot hide the real URL from the check.
export function navigationUrlsFromArgs(args = []) {
  const urls = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] ?? '');
    if (token === '--format') { index += 1; continue; }
    if (token.startsWith('-')) continue;
    if (parseUrl(token)) urls.push(token);
  }
  return urls;
}

// --- messages -------------------------------------------------------------------------------

function stepSuffix(step) {
  return step ? ` (step ${step.index} of ${step.of})` : '';
}

export function deniedActionMessage(name, { step = null } = {}) {
  return `${POLICY_PREFIX}CDP_DENY_ACTIONS blocks "${name}"${stepSuffix(step)}; ${step ? 'no step ran' : 'it did not run'}.`;
}

export function deniedNavigationMessage({ cmd, url, step = null }) {
  return `${POLICY_PREFIX}CDP_ALLOWED_ORIGINS does not allow ${originLabel(url)} (${cmd} ${displayPolicyUrl(url)})${stepSuffix(step)}; `
    + `the tab was not navigated${step ? ' and no step ran' : ''}.`;
}

export function navigationViolationMessage({ cmd, url }) {
  return `${POLICY_PREFIX}CDP_ALLOWED_ORIGINS does not allow ${originLabel(url)}, but "${cmd}" already navigated the tab to ${displayPolicyUrl(url)}. `
    + 'The navigation already happened: the tab is on that page now. The command output is withheld because it may hold content from that page.';
}

export function skippedAfterViolationMessage({ cmd, url }) {
  return `${POLICY_PREFIX}"${cmd}" did not run: an earlier step already navigated the tab to ${displayPolicyUrl(url)}, `
    + `which CDP_ALLOWED_ORIGINS does not allow (${originLabel(url)}).`;
}

// --- checks ---------------------------------------------------------------------------------

export function deniedCommandMessage(policy, cmd, { surface = COMMAND_SURFACE } = {}) {
  if (!policy?.denyActions) return null;
  const command = surface.resolve(String(cmd || ''));
  if (!command || !policy.denyActions.includes(command.name)) return null;
  return deniedActionMessage(command.name);
}

export function navigationBlockedMessage(policy, url, cmd) {
  if (!policy?.allowedOrigins) return null;
  // An unparseable URL is the command's own usage error, not a policy decision.
  if (!parseUrl(url)) return null;
  return navigationAllowed(url, policy.allowedOrigins) ? null : deniedNavigationMessage({ cmd, url });
}

// Checks one command before it touches the page: the deny-list, a `nav` URL, and, for
// batch/flow/repeat/replay, every step they would run. `compositeSteps(cmd, args)` returns the
// steps as `[{ cmd, args }]`, or null when the arguments do not parse (the command then reports
// its own error).
export function policyPreflightMessage(policy, cmd, args = [], { compositeSteps = null, step = null, depth = 0 } = {}) {
  if (!policy) return null;
  const name = canonicalPolicyCommand(cmd);
  if (policy.denyActions?.includes(name)) return deniedActionMessage(name, { step });
  if (name === 'nav' && policy.allowedOrigins) {
    const url = navigationUrlsFromArgs(args).find(entry => !navigationAllowed(entry, policy.allowedOrigins));
    if (url !== undefined) return deniedNavigationMessage({ cmd: 'nav', url, step });
  }
  if (typeof compositeSteps === 'function' && POLICY_COMPOSITE_COMMANDS.includes(name) && depth < MAX_COMPOSITE_DEPTH) {
    let steps = null;
    try { steps = compositeSteps(name, args); } catch { steps = null; }
    if (!Array.isArray(steps)) return null;
    for (let index = 0; index < steps.length; index += 1) {
      const message = policyPreflightMessage(policy, steps[index]?.cmd, steps[index]?.args || [], {
        compositeSteps,
        step: step || { index: index + 1, of: name },
        depth: depth + 1,
      });
      if (message) return message;
    }
  }
  return null;
}

// --- daemon guard ---------------------------------------------------------------------------

// Main-frame URLs the tab committed, numbered, so a command can ask which ones happened while it ran.
export function createMainFrameNavigationLog({ max = 64 } = {}) {
  let seq = 0;
  const entries = [];
  return Object.freeze({
    record(url) {
      seq += 1;
      entries.push({ seq, url: String(url ?? '') });
      if (entries.length > max) entries.shift();
    },
    mark() {
      return seq;
    },
    since(mark) {
      return entries.filter(entry => entry.seq > mark).map(entry => entry.url);
    },
  });
}

// One per daemon request (null when the request has no policy). `violation` remembers the first
// disallowed navigation, so later steps of the same batch/flow/repeat/replay do not run on it.
export function createRequestPolicyState(wire) {
  if (wire === undefined || wire === null) return null;
  return { policy: parsePolicyWire(wire), violation: null };
}

export async function guardDaemonCommand({
  state,
  cmd,
  args = [],
  execute,
  navigationLog = null,
  compositeSteps = null,
  readContentBoundary = null,
}) {
  if (!state) return execute();
  const name = canonicalPolicyCommand(cmd);
  if (state.violation) {
    return { ok: false, error: skippedAfterViolationMessage({ cmd: name, url: state.violation.url }) };
  }
  const blocked = policyPreflightMessage(state.policy, name, args, { compositeSteps });
  if (blocked) return { ok: false, error: blocked };
  const patterns = state.policy.allowedOrigins;
  const mark = patterns && navigationLog ? navigationLog.mark() : 0;
  const response = await execute();
  if (patterns && navigationLog) {
    const url = navigationLog.since(mark).find(entry => !navigationAllowed(entry, patterns));
    if (url !== undefined) {
      state.violation ||= { url };
      return { ok: false, error: navigationViolationMessage({ cmd: name, url }) };
    }
  }
  if (state.policy.contentBoundary && typeof readContentBoundary === 'function' && response?.ok === true) {
    return { ...response, contentBoundary: await readContentBoundary() };
  }
  return response;
}

// --- content boundaries ---------------------------------------------------------------------

export function createContentBoundaryNonce(random = randomBytes) {
  return random(8).toString('hex');
}

export function isContentBoundary(value) {
  return Boolean(value && typeof value === 'object'
    && CONTENT_BOUNDARY_NONCE_RE.test(String(value.nonce || ''))
    && typeof value.origin === 'string');
}

function boundaryOrigin(origin) {
  const text = String(origin || 'unknown').replace(/\s+/g, '');
  return text.slice(0, MAX_URL_DISPLAY_CHARS) || 'unknown';
}

export function contentBoundaryMarkers(boundary) {
  const nonce = boundary.nonce;
  return {
    start: `--- PAGE CONTENT (untrusted) nonce=${nonce} origin=${boundaryOrigin(boundary.origin)} ---`,
    end: `--- END PAGE CONTENT nonce=${nonce} ---`,
  };
}

// Text output gets start/end markers; a JSON object gets a `contentBoundary` field instead.
export function wrapContentBoundary(output, boundary, { format = 'text' } = {}) {
  if (!isContentBoundary(boundary)) return output;
  const text = String(output ?? '');
  if (format === 'json') {
    try {
      const model = JSON.parse(text);
      if (model && typeof model === 'object' && !Array.isArray(model)) {
        return JSON.stringify({
          ...model,
          contentBoundary: { nonce: boundary.nonce, origin: boundaryOrigin(boundary.origin) },
        }, null, 2);
      }
    } catch {
      // Not one JSON object: fall back to markers.
    }
  }
  const { start, end } = contentBoundaryMarkers(boundary);
  return `${start}\n${text}\n${end}`;
}

// --- recovery -------------------------------------------------------------------------------

export function isPolicyMessage(message) {
  return String(message || '').trim().replace(/^Error:\s*/, '').startsWith(POLICY_PREFIX);
}

export function isPolicyConfigMessage(message) {
  return String(message || '').trim().replace(/^Error:\s*/, '').startsWith(POLICY_CONFIG_PREFIX);
}

export function classifyPolicyMessage(message) {
  if (!isPolicyMessage(message)) return null;
  const text = String(message);
  return {
    rule: text.includes('CDP_DENY_ACTIONS') ? 'deny-actions' : 'allowed-origins',
    navigated: /already navigated the tab/.test(text),
  };
}

// The `Recovery:` block for a policy failure (Kind: policy) or a bad policy variable (Kind: usage).
export function policyRecovery(message, { targetPrefix = '' } = {}) {
  if (isPolicyConfigMessage(message)) {
    return {
      kind: 'usage',
      strategy: 'fix-policy-env',
      ask: 'Fix or unset the variable named in the error, then rerun the command.',
      reason: 'CDP_CONTENT_BOUNDARIES, CDP_ALLOWED_ORIGINS and CDP_DENY_ACTIONS are checked before any command runs.',
    };
  }
  const info = classifyPolicyMessage(message);
  if (!info) return null;
  const target = String(targetPrefix || '').trim();
  const perceive = target ? `cdp perceive ${target} -C -d 8` : null;
  if (info.navigated) {
    return {
      kind: 'policy',
      strategy: 'navigate-back',
      run: target ? `cdp back ${target}` : 'cdp list',
      then: perceive,
      reason: 'The navigation already happened. Go back, or `cdp nav <target> <url>` to an origin in CDP_ALLOWED_ORIGINS, before reading or acting on the page.',
    };
  }
  if (info.rule === 'deny-actions') {
    return {
      kind: 'policy',
      strategy: 'respect-policy',
      run: perceive,
      ask: 'Reach the goal with a command the policy allows, or ask the user to remove it from CDP_DENY_ACTIONS.',
      reason: 'CDP_DENY_ACTIONS blocks this command; nothing touched the page.',
    };
  }
  return {
    kind: 'policy',
    strategy: 'respect-policy',
    run: perceive,
    ask: 'Stay within CDP_ALLOWED_ORIGINS, or ask the user to allow this origin.',
    reason: 'CDP_ALLOWED_ORIGINS does not allow this origin; the tab was not navigated.',
  };
}

// The same text the CLI prints for a policy error, for callers that refuse a command before the
// CLI runs (the MCP adapter).
export function formatPolicyFailureText(message, { targetPrefix = '' } = {}) {
  const text = String(message || '').trim();
  const recovery = policyRecovery(text, { targetPrefix });
  const lines = [text.startsWith('Error:') ? text : `Error: ${text}`];
  if (!recovery) return lines[0];
  lines.push('Recovery:', `  Kind: ${recovery.kind}`, `  Strategy: ${recovery.strategy}`);
  if (recovery.run) lines.push(`  Run: ${recovery.run}`);
  if (recovery.ask && recovery.ask !== recovery.run) lines.push(`  Ask: ${recovery.ask}`);
  if (recovery.then) lines.push(`  Then: ${recovery.then}`);
  if (recovery.reason) lines.push(`  Reason: ${recovery.reason}`);
  lines.push(`Next: ${recovery.run || recovery.ask}`);
  return lines.join('\n');
}
