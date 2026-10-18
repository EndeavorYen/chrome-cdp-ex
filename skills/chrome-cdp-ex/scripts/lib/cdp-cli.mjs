// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { isClassifiedActionFailureText, recoveryCommandArg } from './action-recovery.mjs';
import { absolutizeExpectDownloadOut, parseExpectDownloadArgs } from './click-download.mjs';
import { classifyRawCdpMethod, commandResult, createCommandRegistry, defineCommandSpec } from './command-application.mjs';
import { inspectCommandDispatcher } from './command-dispatch.mjs';
import { COMMAND_SURFACE } from './command-surface.mjs';
import { formatNextClosingLines, formatNextLine } from './next-line.mjs';
import { goldenPathActRecommendation, goldenPathBrowserPermissionRecommendation, goldenPathReadPageRecommendation } from './perception-model.mjs';
import { assertSecretName } from './secrets.mjs';
import { policyRecovery } from './session-policy.mjs';
import { parseTableArgs, parseTableContinuationToken } from './table-contract.mjs';
import { createHash } from 'crypto';
import { ALLOW_STALE_DAEMON_FLAG, COMMANDS, DEFAULT_OPEN_ATTACH_TIMEOUT_MS, DEFAULT_OPEN_READY_TIMEOUT_MS, FILE_URL_HTTP_SERVER, HALT_TRAILER_RE, HIDDEN_TAB_RERUN_COMMANDS, OPEN_CREATED_TARGET_URL, STEP_HEADER_RE, TIMEOUT, USAGE, isFileUrlRefusalMessage, sealErrorRecovery, sleep, sourceFailureRecovery } from './cdp-base.mjs';
import { CDP, discoverWsUrl, formatDuration, formatJson, isBlankPageUrl, parseCompactFormatArgs, parseFormatArgs } from './cdp-browser.mjs';
import { explicitBackgroundChoice, isBackgroundMode, shellQuoteCliArg, tokenizeCommandLine, tokenizeFlowCommandLine } from './cdp-core.mjs';
import { connectToSocket, sendCommand } from './cdp-daemon.mjs';
import { fdLimitRecovery, isolatedSpawnProfileDir, spawnDebugBrowserHelpDetails } from './cdp-doctor.mjs';
import { classifyCommandResultSemantics, commandCatalogName, commandMeta, flowStepHelpLines, maybeParseJson, splitFlowSegmentsRaw } from './cdp-flow.mjs';
import { absolutizeArtifactFileArgs, absolutizeElshotFileArg, absolutizeFullshotArgs, absolutizeResponsiveAuditArgs, absolutizeShotArgs, absolutizeUploadArgs, assertClosedClickTarget, callerPayloadIndexes, canonicalCallerCommand, clickFeedbackPolicy, namedClickActionTarget, parseActionabilityWaitArgs, pressHelpLines, rejoinRewrittenCommand, replaceCallerPayload, sameArgList } from './cdp-input.mjs';
import { cdpDomains, evalScopeHelpLines, isHiddenTabCaptureError, runtimeExceptionMessage } from './cdp-page.mjs';
import { absolutizeNetlogOutArg, fullshotHelpLines } from './cdp-page-commands.mjs';
import { perceiveReadinessRecovery } from './cdp-perceive.mjs';

export function rewriteFlowInput(input, cwd, depth) {
  // Same quote and `\;` boundaries as the step parser. A semicolon inside quotes
  // stays in that step; an escaped semicolon stays escaped in the raw text.
  let steps;
  try {
    steps = splitFlowSegmentsRaw(String(input));
  } catch {
    return input;
  }
  let changed = false;
  const next = steps.map(step => {
    const trimmed = step.trim();
    if (!trimmed) return step;
    // Backticks are flow quotes. A tokenize error stays in the step so the real parser reports it.
    let tokens;
    try {
      tokens = tokenizeFlowCommandLine(trimmed);
    } catch {
      return step;
    }
    if (!tokens.length) return step;
    const head = tokens[0].value;
    if (head === 'wait' || head === 'assert') return step;
    const args = tokens.slice(1).map(token => token.value);
    let rewritten;
    try {
      rewritten = rewriteCallerCommandArgs(head, args, cwd, depth + 1);
    } catch {
      return step;
    }
    if (sameArgList(rewritten, args)) return step;
    changed = true;
    const prefix = step.match(/^\s*/)?.[0] || '';
    return `${prefix}${rejoinRewrittenCommand(head, rewritten)}`.trimEnd();
  });
  return changed ? next.join(';') : input;
}
export function rewriteBatchInput(input, cwd, depth) {
  const text = String(input);
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    let commands;
    try { commands = JSON.parse(trimmed); } catch { return input; }
    if (!Array.isArray(commands)) return input;
    let changed = false;
    const next = commands.map(command => {
      if (!command || typeof command !== 'object' || Array.isArray(command)) return command;
      const args = Array.isArray(command.args) ? command.args.map(String) : [];
      let rewritten = args;
      try { rewritten = rewriteCallerCommandArgs(command.cmd, args, cwd, depth + 1); } catch { rewritten = args; }
      if (sameArgList(rewritten, args)) return command;
      changed = true;
      return { ...command, args: rewritten };
    });
    return changed ? JSON.stringify(next) : input;
  }
  const segments = text.split('|');
  let changed = false;
  const next = [];
  for (const segment of segments) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) {
      next.push(segment);
      continue;
    }
    // `|` is already split. A quote error belongs to parseBatchArgs, not this rewrite.
    let tokens;
    try {
      tokens = tokenizeCommandLine(trimmedSegment);
    } catch {
      return input;
    }
    if (!tokens.length) {
      next.push(segment);
      continue;
    }
    const head = tokens[0].value;
    const args = tokens.slice(1).map(token => token.value);
    let rewritten;
    try {
      rewritten = rewriteCallerCommandArgs(head, args, cwd, depth + 1);
    } catch {
      next.push(segment);
      continue;
    }
    if (sameArgList(rewritten, args)) {
      next.push(segment);
      continue;
    }
    // Batch tokenization understands only ' and ". Backticks would stay in the
    // value. tokenizeCommandLine has no escape, so an unquotable step stays as written.
    const rejoined = rejoinRewrittenCommand(head, rewritten, '"\'');
    if (rejoined == null) {
      next.push(segment);
      continue;
    }
    changed = true;
    next.push(rejoined);
  }
  return changed ? next.join('|') : input;
}
export function absolutizeFlowArgs(args, cwd, depth) {
  if (!Array.isArray(args)) return args;
  const indexes = callerPayloadIndexes(args, new Set());
  if (!indexes.length) return args;
  const input = indexes.map(index => args[index]).join(' ');
  const rewritten = rewriteFlowInput(input, cwd, depth);
  if (rewritten === input) return args;
  return replaceCallerPayload(args, indexes, rewritten);
}
export function absolutizeBatchArgs(args, cwd, depth) {
  if (!Array.isArray(args)) return args;
  const indexes = callerPayloadIndexes(args, new Set(['--parallel', '--plain', '--compact']));
  if (!indexes.length) return args;
  const input = indexes.map(index => args[index]).join(' ');
  const rewritten = rewriteBatchInput(input, cwd, depth);
  if (rewritten === input) return args;
  return replaceCallerPayload(args, indexes, rewritten);
}
export function absolutizeRepeatArgs(args, cwd, depth) {
  if (!Array.isArray(args)) return args;
  const untilFlags = new Set(['--until-selector', '--until-selector-missing', '--until-text']);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--continue' || token === '-c') continue;
    if (untilFlags.has(token)) {
      i += 1;
      continue;
    }
    positional.push(i);
  }
  if (positional.length < 3) return args;
  const argIndexes = positional.slice(2);
  const inner = argIndexes.map(index => args[index]);
  const rewritten = rewriteCallerCommandArgs(args[positional[1]], inner, cwd, depth + 1);
  if (sameArgList(rewritten, inner)) return args;
  if (rewritten.length === inner.length) {
    const next = args.slice();
    argIndexes.forEach((index, offset) => { next[index] = rewritten[offset]; });
    return next;
  }
  for (let i = 1; i < argIndexes.length; i++) {
    if (argIndexes[i] !== argIndexes[i - 1] + 1) return args;
  }
  const start = argIndexes[0];
  const end = argIndexes[argIndexes.length - 1];
  return [...args.slice(0, start), ...rewritten, ...args.slice(end + 1)];
}
// Top-level commands and the same paths nested in flow, batch, and repeat (#577).
export function rewriteCallerCommandArgs(cmd, args, cwd, depth) {
  if (depth > 8 || !Array.isArray(args)) return args;
  switch (canonicalCallerCommand(cmd)) {
    case 'shot': return absolutizeShotArgs(args, cwd);
    case 'fullshot': return absolutizeFullshotArgs(args, cwd);
    case 'elshot': return absolutizeElshotFileArg(args, cwd);
    case 'upload': return absolutizeUploadArgs(args, cwd);
    case 'replay':
    case 'restore': return absolutizeArtifactFileArgs(args, cwd);
    case 'responsive-audit': return absolutizeResponsiveAuditArgs(args, cwd);
    case 'netlog': return absolutizeNetlogOutArg(args, cwd);
    case 'click': return absolutizeExpectDownloadOut(args, cwd);
    case 'flow': return absolutizeFlowArgs(args, cwd, depth);
    case 'batch': return absolutizeBatchArgs(args, cwd, depth);
    case 'repeat': return absolutizeRepeatArgs(args, cwd, depth);
    default: return args;
  }
}
export function absolutizeCallerFileArgs(cmd, args = [], cwd = process.cwd()) {
  return rewriteCallerCommandArgs(cmd, args, cwd, 0);
}
export function helpStr() {
  return USAGE;
}
export function recordActionsHelpLines() {
  return [
    'stop, an idle exit, a crash, and kill -9 keep the action log.',
    'record-actions <target> --clear empties that log and the recorded environment steps and keeps the netlog buffer. Mock rules, throttle, and dialog mode stay active.',
    'closetab removes the saved file.',
    'To export only new steps, run record-actions <target> --clear before them.',
    '--clear cannot be combined with an export flag.',
  ];
}
export function helpTopicStr(topic) {
  const raw = String(topic || '').trim();
  if (!raw || raw === 'help' || raw === '--help' || raw === '-h') return helpStr();
  const needle = raw.replace(/^-+/, '').toLowerCase();
  const record = COMMAND_SURFACE.resolve(needle);
  if (!record) throw new Error(unknownCommandMessage(raw));
  const lines = [`cdp ${record.help.synopsis}`, record.help.summary];
  if (record.aliases?.length) lines.push(`Aliases: ${record.aliases.join(', ')}`);
  if (record.name === 'spawn-debug-browser') lines.push(...spawnDebugBrowserHelpDetails());
  if (record.name === 'eval' || record.name === 'eval64') lines.push(...evalScopeHelpLines());
  if (record.name === 'press') lines.push(...pressHelpLines());
  if (record.name === 'flow') lines.push(...flowStepHelpLines());
  if (record.name === 'fullshot') lines.push(...fullshotHelpLines());
  if (record.name === 'record-actions') lines.push(...recordActionsHelpLines());
  lines.push('Run `cdp help` for the survivor card; leftover verbs: `cdp help <command>`.');
  return `${lines.join('\n')}\n`;
}
export function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}
export function snapshotApplicationDataObject(input, path) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error(`${path}: must be a plain data object`);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path}: must be a plain data object without a custom prototype`);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === 'symbol') throw new Error(`${path}: symbol keys are not allowed`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(`${path}.${key}: must be an own data property, not an accessor`);
    if (descriptor.enumerable !== true) throw new Error(`${path}.${key}: must be enumerable`);
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return snapshot;
}
export function snapshotApplicationArray(input, path, { max = 256 } = {}) {
  if (!Array.isArray(input)) throw new Error(`${path}: must be an array`);
  if (Object.getPrototypeOf(input) !== Array.prototype) throw new Error(`${path}: must be a plain array`);
  if (!Number.isSafeInteger(input.length) || input.length > max) throw new Error(`${path}: exceeds the ${max}-item array limit`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') throw new Error(`${path}: symbol keys are not allowed`);
    if (key === 'length') continue;
    if (!/^\d+$/.test(key)) throw new Error(`${path}.${key}: is not allowed`);
    if (!Object.hasOwn(descriptors[key], 'value')) throw new Error(`${path}[${key}]: must be a data property, not an accessor`);
  }
  const values = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(`${path}[${index}]: must be an own data property`);
    values.push(descriptor.value);
  }
  return values;
}
export function buildApplicationCommandSpecs(commands) {
  const authority = new Map(COMMAND_SURFACE.commands.map(command => [command.name, command]));
  const candidates = snapshotApplicationArray(commands, 'commands', { max: authority.size })
    .map((command, index) => snapshotApplicationDataObject(command, `commands[${index}]`));
  if (candidates.length !== authority.size) throw new Error(`commands: expected exactly ${authority.size} authoritative records`);
  const allowedKeys = new Set(['name', 'aliases', 'needsTarget', 'mutates', 'feedbackPolicy', 'outputFormats']);
  const requiredKeys = new Set(['name', 'aliases', 'needsTarget', 'mutates', 'outputFormats']);
  for (const [index, command] of candidates.entries()) {
    for (const key of Reflect.ownKeys(command)) {
      if (!allowedKeys.has(key)) throw new Error(`commands[${index}].${key}: is not allowed`);
    }
    for (const key of requiredKeys) {
      if (!Object.hasOwn(command, key)) throw new Error(`commands[${index}].${key}: is required`);
    }
    if (!authority.has(command.name)) throw new Error(`commands[${index}].name: unknown command ${command.name}`);
  }
  const specs = [];
  for (const name of [...authority.keys()].sort()) {
    const matches = candidates.filter(command => command.name === name);
    if (matches.length !== 1) throw new Error(`${name}.name: expected exactly one command from command-surface authority`);
    const command = matches[0];
    const canonical = authority.get(name);
    const hasFeedbackPolicy = Object.hasOwn(command, 'feedbackPolicy');
    const expectsFeedbackPolicy = canonical.feedbackPolicy !== null;
    if (hasFeedbackPolicy !== expectsFeedbackPolicy) {
      throw new Error(`${name}.feedbackPolicy: ${expectsFeedbackPolicy ? 'is required' : 'is not allowed'}`);
    }
    for (const field of ['needsTarget', 'mutates']) {
      if (command[field] !== canonical[field]) throw new Error(`${name}.${field}: drifted from COMMANDS authority`);
    }
    const feedbackPolicy = command.feedbackPolicy ?? null;
    if (feedbackPolicy !== (canonical.feedbackPolicy ?? null)) {
      throw new Error(`${name}.feedbackPolicy: drifted from COMMANDS authority`);
    }
    const arrays = {};
    for (const field of ['aliases', 'outputFormats']) {
      arrays[field] = snapshotApplicationArray(command[field], `${name}.${field}`);
      if (!sameStringArray(arrays[field], canonical[field])) {
        throw new Error(`${name}.${field}: drifted from COMMANDS authority`);
      }
    }
    specs.push(defineCommandSpec({
      name: command.name,
      aliases: arrays.aliases,
      needsTarget: command.needsTarget,
      mutates: command.mutates,
      feedbackPolicy,
      outputFormats: arrays.outputFormats,
      kind: canonical.kind,
      authorization: canonical.authorization,
      evidencePolicy: canonical.evidencePolicy,
    }));
  }
  return Object.freeze(specs);
}
export function createApplicationCommandRegistry(commands) {
  return createCommandRegistry(buildApplicationCommandSpecs(commands));
}
export function parseFillArgs(args = []) {
  const wait = parseActionabilityWaitArgs(args, 'fill');
  const fopts = parseCompactFormatArgs(wait.args, ['text', 'json']);
  let react = false;
  let secretName = null;
  let acceptFlags = true;
  const positional = [];
  for (let index = 0; index < fopts.args.length; index += 1) {
    const token = fopts.args[index];
    if (acceptFlags && token === '--') {
      acceptFlags = false;
      continue;
    }
    if (acceptFlags && token === '--react') {
      react = true;
      continue;
    }
    if (acceptFlags && token === '--secret') {
      if (secretName != null) throw new Error('fill: --secret may be given only once');
      secretName = assertSecretName(fopts.args[index + 1]);
      index += 1;
      continue;
    }
    if (acceptFlags && (token === '--help' || token === '-h')) {
      const err = new Error('fill: help requested');
      err.code = 'help_requested';
      err.helpTopic = 'fill';
      throw err;
    }
    if (acceptFlags && String(token).startsWith('--')) {
      throw new Error(`fill: unknown argument ${token}`);
    }
    positional.push(token);
  }
  const selector = positional[0] || '';
  if (secretName != null && positional.length > 1) {
    throw new Error('fill: --secret NAME replaces <text>; pass one or the other');
  }
  // null = no text argument (an error); '' = an explicit empty string, which clears the field.
  // With --secret the text is the secret's value, resolved in the daemon request (#469).
  const text = positional.length > 1 ? positional.slice(1).join(' ') : null;
  return {
    format: fopts.format,
    compact: fopts.compact,
    qa: fopts.qa,
    full: fopts.full,
    maxDiffLines: fopts.maxDiffLines,
    react,
    waitMs: wait.waitMs,
    selector,
    text,
    secretName,
    args: positional,
    fopts: { ...fopts, args: positional },
  };
}
export function parseClickArgs(args = []) {
  const wait = parseActionabilityWaitArgs(args, 'click');
  const fopts = parseCompactFormatArgs(wait.args, ['text', 'json']);
  const { args: clickTokens, download } = parseExpectDownloadArgs(fopts.args);
  let js = false;
  let pointer = false;
  const positional = [];
  for (const token of clickTokens) {
    if (token === '--js' || token === '-j') {
      js = true;
      continue;
    }
    if (token === '--pointer') {
      pointer = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      const err = new Error('click: help requested');
      err.code = 'help_requested';
      err.helpTopic = 'click';
      throw err;
    }
    if (String(token).startsWith('--')) {
      throw new Error(`click: unknown argument ${token}`);
    }
    positional.push(token);
  }
  if (js && pointer) throw new Error('click: --pointer and --js are alternatives; use one');
  assertClosedClickTarget(positional[0] || '');
  return {
    format: fopts.format,
    compact: fopts.compact,
    qa: fopts.qa,
    full: fopts.full,
    maxDiffLines: fopts.maxDiffLines,
    js,
    pointer,
    waitMs: wait.waitMs,
    download,
    selector: positional[0] || '',
    args: positional,
    fopts: { ...fopts, args: positional },
  };
}
export function createClickCommandHandler({ actionFeedback, click, jsClick, pointerClick, expectDownload }) {
  return async ({ args }) => {
    const parsed = parseClickArgs(args);
    const selector = parsed.selector;
    // A plain label goes through click(), which hit-tests. --js is the hit-test bypass.
    const useJs = parsed.js;
    const baseArgs = parsed.pointer ? ['--pointer', selector] : parsed.js ? ['--js', selector] : [selector];
    const target = namedClickActionTarget(selector, {
      commandArgs: parsed.download ? [...baseArgs, '--expect-download'] : baseArgs,
    });
    // Shared with the dispatch: actionFeedback shallow-copies the target, so
    // mutations of this object survive onto the receipt.
    const clickTrust = {};
    target.clickTrust = clickTrust;
    const clickOnce = parsed.pointer
      ? () => pointerClick(selector, clickTrust)
      : () => (useJs ? jsClick(selector, clickTrust) : click(selector, {
        waitMs: parsed.waitMs,
        clickTrust,
        ...(parsed.download ? { captureDownload: true } : {}),
      }));
    let dispatch = clickOnce;
    if (parsed.download) {
      if (typeof expectDownload !== 'function') throw new Error('click: --expect-download is not available on this path');
      // #472: effects.download reaches the receipt through this holder (see actionFeedback).
      const effects = {};
      target.actionEffects = effects;
      dispatch = () => expectDownload(parsed.download, clickOnce, effects);
    }
    const value = await actionFeedback(
      'click',
      dispatch,
      target,
      clickFeedbackPolicy(selector),
      null,
      parsed.fopts
    );
    return commandResult(value, { kind: 'action-receipt' });
  };
}
export function createEvalrawCommandHandler({ evalRaw }) {
  return async ({ args, authorization }) => {
    const method = args[0];
    const value = await evalRaw(method, args[1], authorization);
    return commandResult(value, {
      kind: 'raw-audit',
      method,
      sideEffectClass: classifyRawCdpMethod(method),
    });
  };
}
export function authorizeDaemonApplicationCommand({ command, args = [], policy, mutates, targetBound }) {
  if (!targetBound) return { allowed: false, code: 'target-not-bound' };
  const actionMutates = ['dialog', 'hover', 'keepalive', 'loadall'].includes(command)
    ? mutates === false
    : mutates === true;
  const tablePolicyMatches = command === 'table' && policy === 'conditional' && mutates === false;
  if (tablePolicyMatches) parseTableArgs(args);
  const allowed = ([
    'back', 'click', 'clickxy', 'clock', 'closetab', 'dismiss-modal', 'drag', 'fill', 'forward', 'hover',
    'cookiedel', 'cookieset', 'dialog', 'emulate', 'jsclick', 'keepalive', 'mock',
    'inject', 'loadall', 'nav', 'press', 'qa', 'reload', 'responsive-audit', 'restore', 'scroll',
    'select', 'throttle', 'type', 'upload', 'verify-click', 'viewport',
  ].includes(command)
      && policy === 'mutation' && actionMutates)
    || (['console', 'diff-shot', 'elshot', 'fullshot', 'netlog', 'record', 'record-actions', 'shot'].includes(command)
      && policy === 'conditional' && mutates === false)
    || tablePolicyMatches
    || (['batch', 'flow', 'repeat'].includes(command)
      && policy === 'composite' && mutates === false)
    || (command === 'replay' && policy === 'mutation' && mutates === true)
    || (['eval', 'eval64', 'call'].includes(command)
      && policy === 'raw-script' && mutates === false)
    || (command === 'evalraw' && policy === 'raw-cdp' && mutates === false)
    || (['components', 'checkpoint', 'cookies'].includes(command)
      && policy === 'sensitive-read' && mutates === false);
  return allowed
    ? { allowed: true, code: 'daemon-application' }
    : { allowed: false, code: 'policy-denied' };
}
export async function executeDaemonApplicationRoute(requestInput, context, execution = undefined) {
  inspectCommandDispatcher(context);
  const request = snapshotApplicationDataObject(requestInput, 'daemon route request');
  const expectedKeys = new Set(['cmd', 'args', 'targetBound']);
  for (const key of Object.keys(request)) {
    if (!expectedKeys.has(key)) throw new Error(`daemon route request.${key}: is not allowed`);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(request, key)) throw new Error(`daemon route request.${key}: is required`);
  }
  const route = await context.execute({
    name: request.cmd,
    args: request.args,
    targetBound: request.targetBound,
  }, execution);
  const semantics = classifyCommandResultSemantics(
    { ok: true, result: route.result },
    { command: request.cmd },
  );
  if (!semantics.ok) {
    return {
      handled: route.handled,
      ok: false,
      result: route.result,
      error: semantics.error,
    };
  }
  return {
    handled: route.handled,
    result: route.result,
  };
}
export function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const rows = s.length + 1;
  const cols = t.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[s.length][t.length];
}
export function suggestCommands(input, { limit = 3, maxDistance = 2 } = {}) {
  const needle = String(input || '').trim().toLowerCase();
  if (!needle) return [];
  // Exact alias → suggest the canonical command name.
  const exact = commandMeta(needle);
  if (exact && exact.name !== needle) return [exact.name];

  const scored = [];
  for (const command of COMMANDS) {
    const candidates = [command.name, ...(command.aliases || [])];
    let best = Infinity;
    for (const name of candidates) {
      if (name === needle) { best = 0; break; }
      let score = editDistance(needle, name);
      if (name.startsWith(needle) || needle.startsWith(name)) score = Math.min(score, 1);
      if (name.includes(needle) || needle.includes(name)) score = Math.min(score, 2);
      best = Math.min(best, score);
    }
    if (best > 0 && best <= maxDistance) scored.push({ name: command.name, score: best });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map(entry => entry.name);
}
export function unknownCommandMessage(cmd) {
  const suggestions = suggestCommands(cmd);
  const base = `Unknown command: ${cmd}`;
  if (!suggestions.length) return base;
  return `${base}\nDid you mean: ${suggestions.join(' / ')}?`;
}
export function parseTargetAndCommandArgs(cmd, args) {
  let targetPrefix = args[0];
  let cmdArgs = args.slice(1);
  if (cmd === 'wait' && /^\d+$/.test(args[0] || '') && args[1] && !/^\d+$/.test(args[1] || '')) {
    targetPrefix = args[1];
    cmdArgs = [args[0], ...args.slice(2)];
  }
  return { targetPrefix, cmdArgs };
}
export function detectCliErrorFormat(args = []) {
  try {
    return parseFormatArgs(args, ['text', 'json']).format;
  } catch {
    return 'text';
  }
}
export function targetCommandCliErrorFormat(targetPrefix, cmdArgs = [], originalArgs = []) {
  const targetLooksLikeFlag = targetPrefix && String(targetPrefix).startsWith('--');
  return detectCliErrorFormat(targetLooksLikeFlag ? originalArgs : cmdArgs);
}
export function formatArgSuffix(format, { compact = false, full = false } = {}) {
  return [
    ...(format && format !== 'text' ? ['--format', format] : []),
    ...(compact ? ['--compact'] : []),
    ...(full ? ['--full'] : []),
  ];
}
export function normalizeTargetCommandArgs(cmd, cmdArgs = []) {
  const args = [...cmdArgs];
  if (cmd === 'type') {
    const fopts = parseCompactFormatArgs(args, ['text', 'json']);
    return [fopts.args.join(' '), ...formatArgSuffix(fopts.format, fopts)];
  }
  if (cmd === 'fill') {
    const parsed = parseFillArgs(args);
    const suffix = formatArgSuffix(parsed.format, parsed);
    const text = parsed.secretName != null ? ['--secret', parsed.secretName] : (parsed.text == null ? [] : [parsed.text]);
    const wait = parsed.waitMs == null ? [] : ['--wait-ms', String(parsed.waitMs)];
    if (parsed.react) return ['--react', parsed.selector, ...text, ...suffix, ...wait];
    return [parsed.selector, ...text, ...suffix, ...wait];
  }
  return args;
}
// `type --secret NAME` would type the flag itself; only a text that starts with it is refused.
export function typeTextNamesSecret(text) {
  return /^--secret(?:\s|$)/.test(String(text ?? ''));
}
// CLI validation for fill: a missing text argument is an error, an explicit "" is a clear.
export function fillCliArgError(cmdArgs = []) {
  let parsed;
  try {
    parsed = parseFillArgs(cmdArgs);
  } catch {
    return null; // parseFillArgs errors (unknown flag, --help) surface from the command itself
  }
  if (!parsed.selector) return 'selector required';
  if (parsed.text == null && parsed.secretName == null) return 'text required';
  return null;
}
export function commandUsageTemplate(cmd = '', targetPrefix = '') {
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
    case 'drag':
      return `cdp drag ${target} <from selector|@ref> <to selector|@ref|x,y>`;
    case 'fill':
      return `cdp fill ${target} <selector|@ref> <text>`;
    case 'type':
      return `cdp type ${target} <text>`;
    case 'press':
    case 'key':
      return 'cdp help press';
    case 'elshot':
      return `cdp elshot ${target} <selector|@ref> [file]`;
    case 'eval':
      return 'cdp help eval';
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
      return `cdp upload ${target} <selector|@ref> <file-path>`;
    case 'batch':
      return 'cdp help batch';
    case 'flow':
      return `cdp flow ${target} "click @1; wait dom stable; summary"`;
    case 'replay':
      return 'cdp help replay';
    case 'restore':
      return 'cdp help restore';
    case 'inject':
      return `cdp inject ${target} --css "body { outline: 1px solid red }"`;
    case 'stop':
      return 'cdp stop [target|--all]';
    case 'target':
      return 'cdp help target';
    case 'text':
      return 'cdp help text';
    case 'waitfor':
      return 'cdp help waitfor';
    case 'wait':
      return 'cdp help wait';
    case 'repeat':
      return 'cdp help repeat';
    case 'loadall':
      return 'cdp help loadall';
    case 'verify-click':
    case 'verifyclick':
      return 'cdp help verify-click';
    case 'tab-group':
    case 'tabgroup':
      return 'cdp help tab-group';
    case 'select':
      return 'cdp help select';
    case 'forget':
      return 'cdp help forget';
    default:
      return `cdp ${cmd || '<command>'}${targetPrefix ? ` ${target}` : ''} <required-args>`;
  }
}
export function jsclickSelectorFromCliError(message, { cmd = '', args = [], err = null } = {}) {
  const fromTarget = String(err?.target?.input || err?.clickSelector || '').trim();
  if (fromTarget && !/^\d+(?:\.\d+)?\s*,\s*\d+/.test(fromTarget)) return fromTarget;
  const fromMessage = String(message || '').match(
    /no mousedown\/click events at \([^)]*\)(?: for (.+?))?\. The mouse path/i
  );
  if (fromMessage?.[1]) return fromMessage[1];
  const cmdName = String(cmd || '').toLowerCase();
  const first = args?.[0];
  if ((cmdName === 'click' || cmdName === 'jsclick') && first && !/^\d+(\.\d+)?$/.test(String(first))) {
    return String(first);
  }
  return '';
}
// Page prose such as "Field is required" is not a missing argument. Tool errors are
// "selector required", "Expression required", "restore requires …", or "<cmd>: … required".
function toolMissingArgumentMessage(message) {
  const text = String(message || '').trim();
  if (!/required/i.test(text)) return false;
  if (/^[a-z0-9-]+:\s/i.test(text)) return true;
  if (/\b(?:is|are|was|were|be)\s+required\b/i.test(text)) return false;
  return true;
}

const CLI_ERROR_SOURCE_FLAGS = ['pageException', 'navigationFailure', 'usage', 'selectorMiss', 'unknownFrame', 'hoverCovered'];

// The daemon returns a string. A source tag rides along as errorSource so the CLI
// can classify a page exception without reading the page's message.
export function cliErrorFromDaemonResponse(response) {
  const message = response?.error;
  const source = response?.errorSource;
  if (typeof message !== 'string' || !source || typeof source !== 'object' || Array.isArray(source)) {
    return message;
  }
  const err = new Error(message);
  let tagged = false;
  for (const flag of CLI_ERROR_SOURCE_FLAGS) {
    if (source[flag] === true) {
      err[flag] = true;
      tagged = true;
    }
  }
  if (source.code === 'usage') {
    err.code = 'usage';
    tagged = true;
  }
  return tagged ? err : message;
}

function hoverSelectorRecovery(message, { cmd = '', target = '<target>' } = {}) {
  const text = String(message || '').trim();
  const run = `cdp perceive ${target} -C -d 8`;
  if (/(?:^|\n)(?:Error:\s*)?hover: ".*" is a text query; hover takes a CSS selector or an @ref\./.test(text)) {
    return {
      kind: 'usage',
      strategy: 'refresh-perception',
      run,
      reason: 'hover takes a CSS selector or an @ref; text= names are resolved only by click and jsclick. Find the element with perceive and hover its @ref, or use a CSS selector.',
    };
  }
  if (cmd !== 'hover') return null;
  if (/^(?:Error:\s*)?invalid selector: /i.test(text)) {
    return {
      kind: 'invalid-selector',
      strategy: 'refresh-perception',
      run,
      reason: 'The selector is not valid CSS. Hover an @ref from perceive, or a CSS selector such as #id or [data-testid].',
    };
  }
  if (/^(?:Error:\s*)?element not found: /i.test(text)) {
    return {
      kind: 'selector',
      strategy: 'refresh-perception',
      run,
      reason: 'No current element matched the selector. Refresh perception and hover an @ref, or a selector that matches.',
    };
  }
  return null;
}
export function buildCliErrorRecovery(message, options) {
  return sealErrorRecovery(buildCliErrorRecoveryBody(message, options));
}

function buildCliErrorRecoveryBody(message, { cmd = '', targetPrefix = '', platform = process.platform, err = null, args = [] } = {}) {
  const lower = String(message || '').toLowerCase();
  const target = targetPrefix || '<target>';
  // #636: page exception, net::ERR_*, unknown @fN, and a missing scroll direction.
  const source = sourceFailureRecovery(err, message, target);
  if (source) {
    return {
      kind: source.kind,
      strategy: source.strategy,
      run: source.next,
      reason: source.reason,
    };
  }
  // #466: CDP_DENY_ACTIONS / CDP_ALLOWED_ORIGINS refusals (Kind: policy) and bad policy variables.
  const sessionPolicyRecovery = policyRecovery(message, { targetPrefix });
  if (sessionPolicyRecovery) return sessionPolicyRecovery;
  // #717: the daemon forwards this usage refusal as text. Next is `frame`, not
  // `perceive --frame` (that read lists the same ref and the action loops) and not `status`.
  if (lower.includes('actions inside cross-site frames are not supported yet')) {
    return {
      kind: 'usage',
      strategy: 'list-frames',
      run: `cdp frame ${target}`,
      reason: 'Actions inside cross-site frames are not supported yet.',
    };
  }
  // #587: file: is refused on purpose. The Next command serves that file's folder.
  if (isFileUrlRefusalMessage(message)) {
    return {
      kind: 'usage',
      strategy: 'serve-file-over-http',
      run: FILE_URL_HTTP_SERVER,
      reason: 'file: URLs are refused on purpose. Run the server in the file\'s folder, then open the http URL named in the error.',
    };
  }
  // #750: hover failures that are not a delivery miss. Each is anchored at a line start, ahead of
  // the generic substring rules, so a selector or page text quoted in a message cannot pick a rule.
  // The text query is hover's own message, so it is classified inside flow and batch too.
  const hoverRecovery = hoverSelectorRecovery(message, { cmd, target });
  if (hoverRecovery) return hoverRecovery;
  // #534: CDP_ISOLATED_ONLY refused a daily or unidentified profile; start an isolated browser instead.
  if (err?.code === 'daily_profile_refused') {
    const browser = err.profile?.browser || 'chrome';
    const port = '9333';
    return {
      kind: 'policy',
      strategy: 'use-isolated-browser',
      run: `cdp spawn-debug-browser ${browser} --port ${port} --user-data-dir ${shellQuoteCliArg(isolatedSpawnProfileDir(browser, port))}`,
      consentRequired: true,
      then: `CDP_PORT=${port} cdp list`,
      reason: 'CDP_ISOLATED_ONLY=1 keeps automation out of the daily profile (browser default or chrome-cdp-ex/daily-*). Launching a separate isolated browser opens a window, so ask first.',
    };
  }
  if (err?.code === 'daemon_socket_path_too_long' || lower.includes('over the 107-byte unix socket limit') || lower.includes('over the 103-byte unix socket limit')) {
    // #444: rerun the same command with a runtime dir short enough for a Unix socket path.
    const rerun = ['cdp', cmd || 'list', ...(targetPrefix ? [targetPrefix] : []), ...(args || []).map(recoveryCommandArg).filter(Boolean)];
    return {
      kind: 'runtime-dir',
      strategy: 'shorten-runtime-dir',
      run: `XDG_RUNTIME_DIR=/tmp/cdp-rt ${rerun.join(' ')}`,
      reason: 'The per-tab daemon socket path is longer than the OS allows; a shorter XDG_RUNTIME_DIR keeps each tab on its own socket.',
    };
  }
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
  if (isHiddenTabCaptureError(err) || isHiddenTabCaptureError({ message })) {
    // #488: CDP_BACKGROUND=0 on this one call activates the tab before the command runs. Only a capture
    // command is rerun whole: a flow/repeat/replay/batch may already have clicked or typed, so its
    // recovery names the capture alone and never replays the earlier steps.
    const captureCommand = HIDDEN_TAB_RERUN_COMMANDS.has(COMMAND_SURFACE.resolve(cmd)?.name || cmd);
    const rerun = captureCommand
      ? ['cdp', cmd, target, ...(args || []).map(recoveryCommandArg).filter(Boolean)]
      : ['cdp', 'shot', target];
    return {
      kind: 'hidden-tab',
      strategy: 'activate-tab',
      run: `CDP_BACKGROUND=0 ${rerun.join(' ')}`,
      reason: captureCommand
        ? 'The tab is hidden and Chrome rendered no frame for it in time. CDP_BACKGROUND=0 on this call activates the tab first (a background tab, or a minimized window); a window covered by other windows is not raised by Chrome, so uncover it yourself.'
        : 'A capture step met a hidden tab. Earlier steps already ran: do not rerun the whole command. Take the capture alone with this command (it activates the tab first), then run only the steps that did not run.',
    };
  }
  // #452: say which capture pipeline failed instead of `Kind: unknown`.
  if (
    err?.code === 'screenshot_capture_failed'
    || lower.includes('screenshot failed:')
    || lower.includes('unable to capture screenshot')
    || lower.includes('screenshot alternate capture')
  ) {
    return {
      kind: 'screenshot-capture',
      strategy: 'perceive-instead',
      run: `cdp perceive ${target} -C -d 8`,
      reason: 'Chrome returned no usable frame from the capture pipelines named in the error; the page structure is still readable.',
    };
  }
  // #469: a --secret name that is unset, empty, malformed, or a secrets file that is refused.
  if (
    err?.code === 'unknown_secret'
    || lower.includes('unknown secret')
    || lower.includes('cdp_secrets_file')
    || lower.includes('--secret')
    || /\bsecret name\b|\bsecret [a-z0-9_]+ (?:is empty|was not provided)/.test(lower)
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help fill',
      reason: 'fill --secret NAME reads CDP_SECRET_<NAME> or the NAME entry of CDP_SECRETS_FILE at call time. Set it, then rerun; only names are ever listed.',
    };
  }
  // Discovery already asked doctor's recommendation for this same CDP check (#425): use it as is.
  if (err?.cdpRecovery?.kind) return { ...err.cdpRecovery };
  if (
    err?.code === 'cdp_unreachable'
    || lower.includes('cannot reach cdp')
    || lower.includes('no devtoolsactiveport')
    || lower.includes('websocket error')
    || lower.includes('remote-debugging-port')
  ) {
    if (err?.profileDir && err?.relaunch) {
      return {
        kind: 'browser-cdp',
        strategy: 'relaunch-same-profile',
        run: err.relaunch,
        reason: 'Chrome debugging endpoint is down. Relaunch the same user-data-dir; do not invent a new profile.',
        ...(Array.isArray(err.candidates) && err.candidates.length > 1 ? { candidates: err.candidates } : {}),
      };
    }
    if (err?.code === 'cdp_unreachable' || lower.includes('cannot reach cdp')) {
      return {
        kind: 'browser-cdp',
        strategy: 'enable-existing-debugging',
        run: err?.relaunch || 'cdp doctor',
        reason: 'Chrome debugging endpoint is down. Do not invent a new --user-data-dir; enable remote debugging on the existing browser via chrome://inspect/#remote-debugging.',
      };
    }
    return {
      kind: 'browser-cdp',
      strategy: 'run-doctor',
      run: 'cdp doctor',
      reason: 'Chrome is not reachable through the configured debugging endpoint.',
    };
  }
  if (
    err?.code === 'unknown_alias'
    || lower.includes('unknown alias')
  ) {
    return {
      kind: 'target-resolution',
      strategy: 'list-aliases',
      run: 'cdp list',
      then: 'cdp current',
      reason: 'The named alias is not saved. List tabs or inspect current aliases.',
    };
  }
  // #538: the prefix vanished but one live page has its last-seen URL and title: rerun on that page.
  if (err?.code === 'target_successor' && err.successorPrefix) {
    // An empty or space-padded argument (`fill <t> #pw ""`) is part of the command: quote it as typed.
    const rerun = ['cdp', cmd || 'perceive', err.successorPrefix, ...(args || []).map(arg => (arg === '' ? '""' : String(arg).trim() !== String(arg) ? `'${String(arg).replace(/'/g, "'\\''")}'` : recoveryCommandArg(arg))).filter(Boolean)];
    return {
      kind: 'target-resolution',
      strategy: 'use-successor-target',
      run: rerun.join(' '),
      reason: 'Chrome gave this tab a new target id without closing it (a navigation or renderer swap). The same URL and title now live under the new prefix; update any script that keeps the old one.',
    };
  }
  if (
    lower.includes('target id required') ||
    lower.includes('no page list cached') ||
    lower.includes('no target matching prefix') ||
    lower.includes('no live target matching prefix') ||
    lower.includes('no live target matching alias') ||
    lower.includes('no page matched')
  ) {
    return {
      kind: 'target-resolution',
      strategy: 'rediscover-target',
      run: 'cdp list',
      then: 'cdp open https://example.com',
      reason: 'The requested tab target could not be resolved from the current page list. If the list is empty, open a page.',
    };
  }
  // #751: both messages ask for an explicit return. The ambiguous one also contains
  // "is ambiguous", so it has to be classified before the prefix rule below.
  if (
    lower.includes('cannot infer the final async expression safely')
    || lower.includes('multi-statement async input is ambiguous')
  ) {
    return {
      kind: 'eval',
      strategy: 'fix-expression',
      run: 'cdp help eval',
      reason: 'The script uses await and the final value is not a single trailing expression. Add an explicit return for the desired result.',
    };
  }
  if (
    lower.includes('ambiguous prefix')
    || lower.includes('is ambiguous')
    || lower.includes('pages matched')
    || /target:\s+\d+\s+pages matched/i.test(message)
  ) {
    return {
      kind: 'target-resolution',
      strategy: 'choose-longer-prefix',
      run: 'cdp list',
      reason: 'More than one tab matches the provided target prefix. Copy a longer target prefix.',
    };
  }
  if (cmd === 'target' && (lower.includes('provide --url') || lower.includes('and/or --title'))) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help target',
      reason: 'target requires --url and/or --title. Print usage instead of probing doctor.',
    };
  }
  if (
    (cmd === 'press' || cmd === 'key')
    && (lower.includes('unknown key') || lower.includes('key name required'))
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help press',
      reason: 'press requires a supported key name. Print usage instead of wrapping as an unclassified action failure.',
    };
  }
  if (
    (cmd === 'wait' || lower.includes('wait duration'))
    && (
      lower.includes('wait duration')
      || lower.includes('positive integer')
      || lower.includes('at least')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help wait',
      reason: 'wait requires a positive millisecond duration. Print usage instead of probing doctor/status.',
    };
  }
  if (
    (cmd === 'repeat'
      || lower.includes('repeat requires')
      || lower.includes('repeat: count')
      || lower.includes('repeat: command name required'))
    && (
      lower.includes('repeat requires')
      || lower.includes('count must be a positive integer')
      || lower.includes('command name required')
      || lower.includes('exceeds cap')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help repeat',
      reason: 'repeat requires a positive count and a command. Print usage instead of probing status.',
    };
  }
  if (
    (cmd === 'verify-click' || cmd === 'verifyclick' || lower.includes('verify-click:'))
    && (
      lower.includes('requires')
      || lower.includes('exactly one selector')
      || lower.includes('unknown argument')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help verify-click',
      reason: 'verify-click needs a selector and paired network assertions. --expect-status alone is not a check.',
    };
  }
  if (
    (cmd === 'restore' || cmd === 'replay'
      || lower.includes('restore:')
      || lower.includes('replay:'))
    && (
      lower.includes('enoent')
      || lower.includes('no such file')
      || lower.includes('unsupported') && lower.includes('schema')
      || lower.includes('requires --file')
      || lower.includes('requires --json')
      || lower.includes('invalid checkpoint')
      || lower.includes('invalid json artifact')
      || lower.includes('artifact must be')
      || lower.includes('checkpoint artifact must')
    )
  ) {
    const helpCmd = cmd === 'replay' || lower.includes('replay') ? 'replay' : 'restore';
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: `cdp help ${helpCmd}`,
      reason: `${helpCmd} needs an existing artifact with a supported schema. Missing files are local usage, not a page failure.`,
    };
  }
  if (
    (cmd === 'diff-shot' || cmd === 'diffshot' || lower.includes('diff-shot:'))
    && (
      lower.includes('timed out')
      || lower.includes('untrusted')
      || lower.includes('capture timed out')
      || lower.includes('timeout: page.capturescreenshot')
    )
  ) {
    return {
      kind: 'timeout',
      strategy: 'retry-or-use-shot',
      run: 'cdp help diff-shot',
      reason: 'Screenshot capture timed out. Do not treat a missing capture as 0% changed.',
    };
  }
  if (
    (cmd === 'tab-group' || cmd === 'tabgroup' || cmd === 'broadcast')
    && (lower.includes('unknown group') || lower.includes('unknown action'))
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: cmd === 'broadcast' ? 'cdp help broadcast' : 'cdp tab-group list',
      reason: 'The named tab group is not stored. List groups instead of probing doctor.',
    };
  }
  if (
    (cmd === 'select' || lower.includes('not a <select>') || lower.includes('no option value'))
    && (
      lower.includes('not a <select>')
      || lower.includes('no option value')
      || lower.includes('css selector or @ref required')
      || lower.includes('css selector required')
      || lower.includes('value required')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help select',
      reason: 'Pass an @ref or a CSS selector for a <select> and an option value or visible label that exists.',
    };
  }
  if (lower.includes('closetab: refusing to close the last open tab') || lower.includes('closetab: unknown argument')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help closetab',
      reason: 'closetab refuses to close the only open tab (the browser may quit). Open another tab first, or pass --force.',
    };
  }
  if (
    (cmd === 'upload' || lower.includes('upload:'))
    && (
      lower.includes('file not found')
      || lower.includes('not a readable file')
      || lower.includes('is not an <input type="file">')
      || lower.includes('css selector or @ref for <input type="file"> required')
      || lower.includes('css selector for <input type="file"> required')
      || lower.includes('refusing to guess')
      || lower.includes('does not accept several files')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help upload',
      reason: 'upload requires an existing readable file and exactly one matching file input. Do not plant a ghost file or guess between inputs.',
    };
  }
  if (
    (cmd === 'cookiedel' || lower.includes('cookie not found') || lower.includes('cookie still present'))
    && (lower.includes('cookie not found') || lower.includes('cookie still present'))
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: targetPrefix ? `cdp cookies ${targetPrefix}` : 'cdp help cookiedel',
      reason: lower.includes('cookie still present')
        ? 'The named cookie is still present after delete. Do not claim deletion.'
        : 'The named cookie is not present. List cookies instead of claiming a delete.',
    };
  }
  if ((cmd === 'netlog' || lower.includes('netlog:')) && lower.includes('no request #')) {
    return {
      kind: 'usage',
      strategy: 'list-requests',
      run: `cdp netlog ${target}`,
      reason: 'That request id is not in this tab\'s network log. List the captured requests and use one of their #ids.',
    };
  }
  if ((cmd === 'netlog' || lower.includes('netlog:')) && lower.includes('--out') && /request #\d+/.test(lower)) {
    const requestId = lower.match(/request #(\d+)/)[1];
    const noBody = lower.includes('has no body to save');
    return {
      kind: 'usage',
      strategy: noBody ? 'inspect-request-without-out' : 'choose-out-path',
      run: noBody
        ? `cdp netlog ${target} --id ${requestId}`
        : `cdp netlog ${target} --id ${requestId} --out <new absolute file path>`,
      reason: noBody
        ? 'This request has no response body to save (it failed, is still loading, or Chrome evicted it). Inspect it without --out.'
        : '--out needs an absolute path in an existing directory that is not a symlink and does not exist yet (or pass --overwrite).',
    };
  }
  // #577: a screenshot path whose parent is missing used to surface as raw ENOENT / Kind: unknown.
  if (lower.includes('output directory does not exist') || lower.includes('output path is not a directory')) {
    const missing = lower.includes('output directory does not exist');
    return {
      kind: 'usage',
      strategy: 'create-output-directory',
      run: cmd ? `cdp help ${commandCatalogName(cmd)}` : 'cdp help shot',
      reason: missing
        ? 'The output directory does not exist. Create it, then rerun. A relative path is resolved from the directory where you ran the command.'
        : 'That output path is not a directory. Choose a file inside a directory. A relative path is resolved from the directory where you ran the command.',
    };
  }
  if (
    lower.includes('unknown option')
    || lower.includes('unknown argument')
    || lower.includes('unknown flag')
    // #536: every `emulate:` parse error (a bad value, off/status with a setting) is a typing mistake.
    || (cmd === 'emulate' && lower.startsWith('emulate:'))
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: cmd ? `cdp help ${cmd}` : 'cdp help',
      reason: 'The command received an unknown flag or argument. Print usage instead of probing doctor/status.',
    };
  }
  if (
    (cmd === 'eval' || cmd === 'eval64' || cmd === 'call')
    && /syntaxerror|referenceerror|typeerror|evalerror|rangeerror|urierror/i.test(message)
  ) {
    let reason = 'The JavaScript expression threw. Fix the expression; the tab is still live.';
    if (cmd === 'eval' || cmd === 'eval64') {
      reason = /already been declared/i.test(message)
        ? 'That name is already declared in this script, or the page declared it in a scope this script shares. let, const, and class from an earlier eval end with that call. The tab is still live.'
        : 'The JavaScript expression threw. Each eval has its own let, const, and class scope and still returns the last expression. var and globalThis assignments stay on the tab. Fix the expression; the tab is still live.';
    }
    return {
      kind: 'eval',
      strategy: 'fix-expression',
      run: 'cdp help eval',
      reason,
    };
  }
  if (err?.code === 'pdf_viewer' || lower.includes('pdf viewer') || lower.includes('application/pdf')) {
    return {
      kind: 'pdf-viewer',
      strategy: 'do-not-probe-ax',
      run: `cdp eval ${target} "document.contentType"`,
      reason: 'Chrome PDF viewer has no accessibility tree. text/perceive cannot extract the PDF body.',
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
    lower.includes('econnrefused') ||
    lower.includes('connect enoent') ||
    lower.includes('connect econnreset') ||
    lower.includes('timed out connecting to daemon socket') ||
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
    const guessed = String(message || '').match(/unknown command:\s*(\S+)/i)?.[1]
      || cmd
      || '';
    const suggestions = suggestCommands(guessed);
    if (suggestions.length) {
      return {
        kind: 'usage',
        strategy: 'suggest-command',
        run: `cdp ${suggestions[0]}`,
        reason: `Did you mean: ${suggestions.join(' / ')}? Run \`cdp help ${suggestions[0]}\` for usage.`,
      };
    }
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
  if (err?.selectorMiss === true || /no element matched/i.test(String(message || ''))) {
    return {
      kind: 'selector',
      strategy: 'refresh-perception',
      run: `cdp perceive ${target} -C -d 8`,
      reason: 'No current element matched the selector. Refresh perception and choose the control again.',
    };
  }
  if (cmd === 'fullshot' && /does not scroll/i.test(String(message || ''))) {
    return {
      kind: 'usage',
      strategy: 'name-scrolling-container',
      run: targetPrefix ? `cdp fullshot ${target}` : 'cdp help fullshot',
      reason: 'That element does not scroll. Omit --scroll-container to capture the document, or name an element whose content is taller than its box.',
    };
  }
  if (cmd === 'fullshot' && /is a frame ref/i.test(String(message || '')) && (err?.usage === true || err?.code === 'usage')) {
    return {
      kind: 'usage',
      strategy: 'use-main-document-container',
      run: `cdp perceive ${target} -C -d 8`,
      reason: 'fullshot --scroll-container looks the element up in the main document. Use a main-document @ref or a CSS selector.',
    };
  }
  if (cmd === 'fullshot' && /^fullshot:/i.test(String(message || '').trim()) && (err?.usage === true || err?.code === 'usage')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help fullshot',
      reason: 'fullshot --scroll-container needs one CSS selector or @ref. --format is text or json.',
    };
  }
  if (cmd && (err?.usage === true || err?.code === 'usage' || toolMissingArgumentMessage(message))) {
    return {
      kind: 'usage',
      strategy: 'provide-required-argument',
      run: commandUsageTemplate(cmd, targetPrefix),
      reason: 'The command is missing required input; provide the required argument instead of retrying unchanged.',
    };
  }
  if (
    (cmd === 'waitfor' && (lower.includes('timeout') || lower.includes('not found within') || lower.includes('still present') || lower.includes('did not stabilise')))
    || /timeout:\s*.+\bnot found within\b/i.test(message)
    || /timeout:\s*.+\bstill present after\b/i.test(message)
    || /timeout:\s*.+\bdid not stabilise\b/i.test(message)
  ) {
    return {
      kind: 'timeout',
      strategy: 'adjust-wait',
      run: 'cdp help waitfor',
      reason: 'The wait condition was not met before the timeout. Increase the bound or use --text / --any-of; the tab is still live.',
    };
  }
  if (
    lower.includes('assertion failed')
    || (cmd === 'flow' && lower.includes('flow halted') && lower.includes('assert'))
  ) {
    return {
      kind: 'assertion',
      strategy: 'inspect-assertion',
      run: 'cdp help flow',
      reason: 'A flow assertion did not hold. The page is still live; inspect the selector or text, or run perceive.',
    };
  }
  if (lower.includes('unknown wait:')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help flow',
      reason: 'flow wait accepts "dom stable", "network idle", or a millisecond count such as wait 2000. Print usage instead of probing status.',
    };
  }
  if (lower.includes('flow: unquoted \\;')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help flow',
      reason: 'An unquoted \\; before a command name keeps a semicolon and swallows the next step. Quote the value, or run cdp help flow.',
    };
  }
  if (lower.includes('flow: unclosed quote') || lower.includes('flow: dangling escape')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help flow',
      reason: 'Close the quote, or use a different quote kind, for example type "\'twas".',
    };
  }
  if (lower.includes('batch --parallel:')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help batch',
      reason: 'batch --parallel only runs read-only/extraction commands. Use sequential batch or flow for mutations.',
    };
  }
  if (
    cmd === 'loadall'
    && (
      lower.includes('still present')
      || lower.includes('aborted')
      || (lower.includes('timeout') && !lower.includes('element not found'))
    )
  ) {
    return {
      kind: 'timeout',
      strategy: 'show-help',
      run: 'cdp help loadall',
      reason: 'loadall stopped before the control disappeared. [interval-ms] is the click interval; pass --timeout-ms to raise the cap.',
    };
  }
  if (
    (cmd === 'loadall' || cmd === 'click' || cmd === 'jsclick')
    && (lower.includes('element not found') || lower.includes('css selector required'))
  ) {
    return {
      kind: cmd === 'loadall' && lower.includes('css selector required') ? 'usage' : 'selector',
      strategy: cmd === 'loadall' && lower.includes('css selector required') ? 'show-help' : 'refresh-perception',
      run: lower.includes('css selector required')
        ? 'cdp help loadall'
        : (targetPrefix ? `cdp perceive ${targetPrefix} -C -d 8` : 'cdp help loadall'),
      reason: 'No current element matched the selector. A missing load-more control is not a successful disappear.',
    };
  }
  if (cmd === 'hover' && lower.includes('the hover was not delivered')) {
    const selector = String(args?.[0] || '').trim();
    const hidden = lower.includes('visibilitystate is hidden');
    const arg = selector ? recoveryCommandArg(selector) : '<sel|@ref>';
    const run = hidden
      ? `CDP_BACKGROUND=0 cdp hover ${target} ${arg}`
      : `cdp perceive ${target} -C -d 8`;
    const covered = !hidden && err?.hoverCovered === true;
    return {
      kind: 'hover-not-delivered',
      strategy: hidden ? 'activate-tab' : 'refresh-perception',
      run,
      reason: hidden
        ? 'The tab is hidden, so the target did not match :hover. CDP_BACKGROUND=0 activates that tab before hover and does not raise a covered window.'
        : covered
          ? 'Another element is at the hover point, so the target did not match :hover. The Error line names that element. Uncover it or hover it, then refresh perception.'
          : 'The target did not match :hover after the mouse move. Refresh perception and choose the control again.',
    };
  }
  if (lower.includes('cross-origin frame received no')) {
    return {
      kind: 'no-input-events',
      strategy: 'inspect-child-frame',
      run: targetPrefix ? `cdp shot ${targetPrefix}` : 'cdp help shot',
      reason: 'The cross-origin frame was probed and received no mouse or click events. Inspect it with shot; do not repeat the click.',
    };
  }
  if (lower.includes('has no clickable box')) {
    const selector = String(err?.noClickBox?.selector || args?.[0] || '').trim();
    const arg = selector ? recoveryCommandArg(selector) : '';
    return {
      kind: 'no-click-box',
      strategy: 'use-jsclick',
      run: (targetPrefix && arg) ? `cdp jsclick ${target} ${arg}` : `cdp perceive ${target} -C -d 8`,
      reason: 'The target has no positive-size box inside the viewport, so no mouse click was sent.',
    };
  }
  if (cmd === 'press' && lower.includes('was not delivered') && lower.includes('no keydown')) {
    const hidden = lower.includes('visibilitystate is hidden');
    const key = String(err?.pressNotDelivered?.key || args?.[0] || '').trim();
    const keyArg = key ? recoveryCommandArg(key) : '';
    return {
      kind: 'press-not-delivered',
      strategy: 'confirm-key-delivery',
      run: hidden
        ? `CDP_BACKGROUND=0 cdp press ${target}${keyArg ? ` ${keyArg}` : ''}`
        : `cdp perceive ${target} -C -d 8`,
      reason: hidden
        ? 'The tab is hidden, so the keydown was not delivered. CDP_BACKGROUND=0 activates the tab and does not raise a covered window.'
        : 'The key was not delivered. The page received no keydown.',
    };
  }
  if (
    lower.includes('received no mousedown/click events')
    || (lower.includes('mouse path failed closed') && lower.includes('jsclick'))
  ) {
    const selector = jsclickSelectorFromCliError(message, { cmd, args, err });
    return {
      kind: 'no-input-events',
      strategy: 'use-jsclick',
      run: (targetPrefix && selector)
        ? `cdp jsclick ${targetPrefix} ${recoveryCommandArg(selector)}`
        : 'cdp help click',
      reason: lower.includes('visibilitystate is hidden')
        ? 'The tab is hidden (window covered or minimised): Input.* events are dropped. Use jsclick, or bring the window to the front. For a background tab, CDP_BACKGROUND=0 on the command activates it first; that does not raise a window other windows cover. Do not treat dispatch.ok as success.'
        : 'The realistic mouse click did not deliver page events. Retry with jsclick instead of treating dispatch.ok as success.',
    };
  }
  if (lower.includes('did not navigate') || (lower.includes('try jsclick') && lower.includes('<a href'))) {
    return {
      kind: 'no-navigation',
      strategy: 'use-jsclick',
      run: targetPrefix ? `cdp jsclick ${targetPrefix} a` : 'cdp help click',
      reason: 'The realistic mouse click dispatched but the link default action did not run.',
    };
  }
  // #527: CdpClient.send rejects with exactly `Timeout: <Domain.method>` when CDP never answers;
  // the whole message must be that (after Error: wrappers), so page errors that merely contain it do not match.
  const cdpTimeoutMethod = String(message || '').trim()
    .match(/^(?:[A-Za-z]*Error:\s*)*Timeout:\s+([A-Z][A-Za-z]*\.[a-z][A-Za-z]*)$/)?.[1];
  if (cdpTimeoutMethod) {
    if (['eval', 'eval64', 'call'].includes(cmd) && /^Runtime\.(?:evaluate|callFunctionOn)$/.test(cdpTimeoutMethod)) {
      return {
        kind: 'timeout',
        strategy: 'poll-in-page',
        run: `cdp eval ${target} --fire-and-forget "<start the work; store progress on window>"`,
        then: `cdp eval ${target} "<read the progress from window>"`,
        reason: `${cmd} waits at most ${TIMEOUT / 1000} s for its value or Promise. Start long work with eval --fire-and-forget, keep progress on window, then poll it with a short eval; the tab is still live.`,
      };
    }
    return targetPrefix ? {
      kind: 'timeout',
      strategy: 'inspect-status',
      run: `cdp status ${targetPrefix}`,
      reason: `CDP did not answer ${cdpTimeoutMethod} in time: the page may be busy (long task), blocked by a dialog, or hung. Check status before retrying.`,
    } : {
      kind: 'timeout',
      strategy: 'run-doctor',
      run: 'cdp doctor',
      reason: `CDP did not answer ${cdpTimeoutMethod} in time: the browser may be busy or hung. Check browser setup before retrying.`,
    };
  }
  return lower.includes('target/document readiness mismatch') ? perceiveReadinessRecovery(target)
    : targetPrefix ? {
        kind: 'unknown',
        strategy: 'inspect-status',
        run: `cdp status ${targetPrefix}`,
        reason: `The ${cmd ? `${cmd} ` : ''}failure was not classified; the Error line is the raw cause. Inspect the target status before retrying.`,
      }
    : {
        kind: 'unknown',
        strategy: 'run-doctor',
        run: 'cdp doctor',
        reason: 'The failure was not classified; check browser setup and available targets.',
      };
}
export function formatCliErrorRecovery(recovery) {
  const lines = [
    'Recovery:',
    `  Kind: ${recovery.kind}`,
    `  Strategy: ${recovery.strategy}`,
  ];
  if (recovery.run) lines.push(`  Run: ${recovery.run}`);
  if (recovery.ask && recovery.ask !== recovery.run) lines.push(`  Ask: ${recovery.ask}`);
  if (!recovery.run && !recovery.ask) lines.push(`  Run: ${recovery.run}`);
  if (recovery.then) lines.push(`  Then: ${recovery.then}`);
  if (recovery.reason) lines.push(`  Reason: ${recovery.reason}`);
  return lines;
}
export function cliErrorMessage(err) {
  return String(err?.message || err || '').trim() || 'unknown failure';
}
export function buildCliErrorModel(err, { cmd = '', targetPrefix = '', platform = process.platform, args = [] } = {}) {
  const completionUnknown = err?.code === 'DAEMON_COMPLETION_UNKNOWN'
    && err?.completion === 'unknown'
    && err?.sideEffectMayHaveOccurred === true;
  const message = completionUnknown
    ? 'The daemon did not return a validated Action Result. The action may have taken effect; do not repeat it until page state is verified.'
    : cliErrorMessage(err);
  const target = targetPrefix || '<target>';
  const recovery = completionUnknown
    ? {
        kind: 'ambiguous-action-completion',
        strategy: 'verify-before-retry',
        run: `cdp perceive ${target} -C -d 8`,
        reason: 'The action may have occurred. Inspect current page state first; do not repeat the action until its effect is verified.',
      }
      : buildCliErrorRecovery(message, { cmd, targetPrefix, platform, err, args });
  const nextSteps = [];
  const commandSteps = Array.isArray(recovery.commands) && recovery.commands.length
    ? recovery.commands.map(command => command?.command).filter(Boolean)
    : [recovery.run, recovery.then];
  for (const step of commandSteps) {
    if (step && !nextSteps.includes(step)) nextSteps.push(step);
  }
  const model = {
    schema: 'chrome-cdp-ex.cli-error.v1',
    ok: false,
    command: cmd || null,
    targetPrefix: targetPrefix || null,
    error: { message },
    recovery,
    nextSteps,
  };
  if (err?.code === 'cdp_unreachable' || recovery.strategy === 'relaunch-same-profile' || recovery.strategy === 'enable-existing-debugging') {
    if (err?.code === 'cdp_unreachable' || /cannot reach cdp/i.test(message)) {
      model.error.code = 'cdp_unreachable';
      model.host = err?.host || null;
      model.port = err?.port || null;
      model.profileDir = err?.profileDir ?? null;
      model.relaunch = err?.relaunch ?? null;
    }
  }
  if (err?.code === 'cdp_profile_in_use' || err?.code === 'cdp_not_found') {
    model.error.code = err.code;
    model.host = err.host || null;
    model.port = err.port || null;
    model.profileDir = err.profileDir ?? null;
    model.relaunch = null;
    if (err.code === 'cdp_profile_in_use') {
      model.pid = err.pid ?? null;
      model.livePort = err.livePort ?? null;
    }
  }
  if (completionUnknown) {
    model.completion = 'unknown';
    model.sideEffectMayHaveOccurred = true;
    model.retrySafe = false;
    model.diagnostics = {
      transport: {
        phase: err.transportCause?.phase || 'awaiting-response',
        kind: err.transportCause?.kind || 'unknown',
        message: String(err.transportCause?.message || 'unknown transport failure').slice(0, 512),
        ...(err.transportCause?.code ? { code: String(err.transportCause.code).slice(0, 64) } : {}),
      },
    };
  }
  return model;
}
export function formatCliError(err, { cmd = '', targetPrefix = '', format = 'text', platform = process.platform, args = [] } = {}) {
  if (format === 'json') return formatJson(buildCliErrorModel(err, { cmd, targetPrefix, platform, args }));
  if (err?.code === 'DAEMON_COMPLETION_UNKNOWN') {
    const model = buildCliErrorModel(err, { cmd, targetPrefix, platform, args });
    return [
      `Error: ${model.error.message}`,
      'Completion: unknown',
      'Side effect may have occurred: yes',
      'Retry safe: no',
      ...formatCliErrorRecovery(model.recovery),
      `Transport: ${model.diagnostics.transport.phase}/${model.diagnostics.transport.kind}: ${model.diagnostics.transport.message}`,
      ...formatNextClosingLines(model.recovery),
    ].join('\n');
  }
  const message = String(err?.message || err || '').trim();
  if (!message) {
    const recovery = buildCliErrorRecovery('unknown failure', { cmd, targetPrefix, platform, args });
    return ['Error: unknown failure', ...formatCliErrorRecovery(recovery), ...formatNextClosingLines(recovery)].join('\n');
  }
  // With `text`, classify that part alone: the err object still carries the whole message.
  const recoveryFor = (text = null) => buildCliErrorRecovery(text ?? message, { cmd, targetPrefix, platform, err: text == null ? err : null, args });
  if (isClassifiedActionFailureText(message)) return withKindOnLastNextLine(message, recoveryFor);
  const lines = [message.startsWith('Error:') ? message : `Error: ${message}`];
  if (/^Next:/m.test(message)) return withKindOnLastNextLine(lines.join('\n'), recoveryFor);

  const recovery = recoveryFor();
  lines.push(...formatCliErrorRecovery(recovery));
  lines.push(...formatNextClosingLines(recovery));
  return lines.join('\n');
}
// Text that arrives already formatted (a classified action failure, or a message with its own Next:)
// keeps its lines. Next stays a bare command (#637).
// - The Kind is the failed block's own: an unindented `Kind:` line, or the first line of a
//   `Recovery:` block, searched upwards from that Next: to the step header. Indented step output
//   (`  Kind: page`) never counts. With none, the recovery classification of that block alone gives
//   it, so an earlier step's output cannot decide it. That kind is inserted on its own line.
// - When only trailers follow that Next: (`Flow halted at step i/n`, `Done: …`, `Dialog: …`,
//   `Downloaded "…"`), it is the failure's command and is repeated as the last line. When anything
//   else follows (`repeat: condition not satisfied`), that Next: is stale, and a fresh recovery Next:
//   classified from the lines after it is appended instead.
export function bareNextCommand(line) {
  return String(line)
    .replace(/^\s*Next:\s*/, '')
    .replace(/\s+\(ask first\)/g, '')
    .replace(/\s+\(Kind:\s*[^)]+\)\s*$/, '')
    .trim();
}
export function kindBeforeNext(lines, nextIndex) {
  let kind = null;
  let blockStart = 0;
  for (let i = nextIndex - 1; i >= 0; i--) {
    if (!kind) {
      kind = lines[i].match(/^Kind: (\S+)/)?.[1]
        || (lines[i - 1] === 'Recovery:' ? lines[i].match(/^\s+Kind: (\S+)/)?.[1] : null);
    }
    if (STEP_HEADER_RE.test(lines[i])) {
      blockStart = i;
      break;
    }
  }
  return { kind, blockStart };
}
function isFrameContentTrailer(lines) {
  const trimmed = [...lines];
  while (trimmed.length && trimmed[0] === '') trimmed.shift();
  while (trimmed.length && trimmed.at(-1) === '') trimmed.pop();
  if (trimmed.length < 2) return false;
  const open = /^--- FRAME CONTENT \(untrusted\) origin=\S+ nonce=([0-9a-f]{32}) ---$/.exec(trimmed[0]);
  const close = /^--- END FRAME CONTENT nonce=([0-9a-f]{32}) ---$/.exec(trimmed.at(-1));
  return Boolean(open && close && open[1] === close[1]);
}
export function withKindOnLastNextLine(text, recoveryFor) {
  const lines = String(text).split('\n');
  const nextIndex = lines.findLastIndex(line => /^Next:/.test(line));
  const trailers = nextIndex < 0 ? lines : lines.slice(nextIndex + 1);
  if (nextIndex < 0) {
    const existingKind = [...lines].reverse().map(line => line.match(/^Kind: (\S+)/)?.[1]).find(Boolean) || null;
    return [...lines, ...formatNextClosingLines(recoveryFor(), { includeKind: true, existingKind })].join('\n');
  }
  if (!trailers.every(line => HALT_TRAILER_RE.test(line))) {
    // The frame block is the receipt body, not a later failure. Keep the Kind/Next above it.
    if (isFrameContentTrailer(trailers)) {
      const command = bareNextCommand(lines[nextIndex]);
      lines[nextIndex] = formatNextLine(command);
      return lines.join('\n');
    }
    // That Next: is stale; the failure is in the lines after it, so classify those alone.
    return [...lines, ...formatNextClosingLines(recoveryFor(trailers.join('\n')), { includeKind: true })].join('\n');
  }
  const command = bareNextCommand(lines[nextIndex]);
  lines[nextIndex] = formatNextLine(command);
  const found = kindBeforeNext(lines, nextIndex);
  const kind = found.kind || recoveryFor(lines.slice(found.blockStart, nextIndex).join('\n')).kind;
  const bare = formatNextLine(command);
  if (lines.at(-1) !== bare) {
    if (kind && found.kind !== kind) lines.push(`Kind: ${kind}`);
    lines.push(bare);
    return lines.join('\n');
  }
  if (kind && !found.kind) lines.splice(nextIndex, 0, `Kind: ${kind}`);
  return lines.join('\n');
}
export function formatDaemonCommandError(err, options = {}) {
  const model = options.format === 'json' && options.cmd === 'flow'
    ? maybeParseJson(cliErrorMessage(err))
    : null;
  if (model?.schema === 'chrome-cdp-ex.flow.v1' && model.halted === true) {
    return formatJson(model);
  }
  return formatCliError(err, options);
}
export function argsWithoutFormat(args = []) {
  try {
    return parseFormatArgs(args, ['text', 'json']).args;
  } catch {
    return args;
  }
}
export function targetPrefixForDisplay(targetId) {
  return String(targetId || '').slice(0, 8) || '<target>';
}
export function parseNonNegativeInteger(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}
export function parseOpenArgs(args = [], env = process.env) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const positional = [];
  let attachTimeoutMs = DEFAULT_OPEN_ATTACH_TIMEOUT_MS;
  let readyTimeoutMs = null;
  let readySelector = null;
  let reuseUrl = false;
  let perceive = false;
  let background = isBackgroundMode(env);
  let backgroundExplicit = explicitBackgroundChoice(env) !== null;
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--background' || token === '--foreground') {
      background = token === '--background';
      backgroundExplicit = true;
    } else if (token === '--attach-timeout-ms') {
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
    } else if (token === '--perceive') {
      perceive = true;
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
    perceive,
    background,
    backgroundExplicit,
  };
}
// The mode `open` chose must reach the tab daemon it spawns, or the daemon's first attach could decide
// differently (`open --background` under CDP_FOREGROUND=1, or `open --foreground`).
export function backgroundDaemonEnv(background, env = process.env) {
  const daemonEnv = { ...env, CDP_BACKGROUND: background ? '1' : '0' };
  delete daemonEnv.CDP_FOREGROUND;
  return daemonEnv;
}
export function openTargetNavigationRequested(createdUrl = OPEN_CREATED_TARGET_URL) {
  const value = String(createdUrl ?? '').trim();
  return !isBlankPageUrl(value) && value !== 'about:blank/';
}
// Background mode opens the tab in its own new window, created without focus: a background tab in an
// existing window is document.visibilityState=hidden, and Page.captureScreenshot can stall there (#415).
export async function createOpenTarget(cdp, { background = false } = {}) {
  const url = OPEN_CREATED_TARGET_URL;
  const params = background ? { url, newWindow: true, background: true } : { url };
  const { targetId } = await cdpDomains(cdp).Target.createTarget( params);
  return targetId;
}
export function openReadyProbeScript(selector = null) {
  return `JSON.stringify({ href: location.href, readyState: document.readyState, selectorFound: ${selector ? `Boolean(document.querySelector(${JSON.stringify(selector)}))` : 'true'} })`;
}
export async function waitForOpenReady(targetId, {
  timeoutMs = DEFAULT_OPEN_READY_TIMEOUT_MS,
  url = '',
  selector = null,
  createCdp = () => new CDP(),
  // The open path already passed the CDP_ISOLATED_ONLY gate; readiness polls skip the profile lookup.
  getWsUrlFn = discoverWsUrl,
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
      const attached = await cdpDomains(cdp).Target.attachToTarget( { targetId, flatten: true }, undefined, probeTimeoutMs);
      const result = await cdpDomains(cdp).Runtime.evaluate( {
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
export function openNavigationScript(url) {
  return `(function() {
    location.assign(${JSON.stringify(url)});
    return JSON.stringify({ method: 'location.assign', target: ${JSON.stringify(url)} });
  })()`;
}
export async function waitForOpenTargetUrl(targetId, url, timeoutMs = 1000, {
  createCdp = () => new CDP(),
  // The open path already passed the CDP_ISOLATED_ONLY gate; readiness polls skip the profile lookup.
  getWsUrlFn = discoverWsUrl,
  now = Date.now,
  sleepFn = sleep,
} = {}) {
  if (!url || url === 'about:blank') return { ok: true, href: 'about:blank' };
  const deadline = now() + Math.max(0, timeoutMs);
  let lastHref = null;
  let lastError = null;
  while (now() <= deadline) {
    const cdp = createCdp();
    try {
      await cdp.connect(await getWsUrlFn());
      const { targetInfos } = await cdpDomains(cdp).Target.getTargets( {}, undefined, Math.min(1000, Math.max(100, deadline - now() + 100)));
      const target = (targetInfos || []).find(t => t.targetId === targetId);
      lastHref = target?.url || null;
      if (lastHref === url) return { ok: true, href: lastHref };
    } catch (e) {
      lastError = e.message || String(e);
    } finally {
      try { cdp.close(); } catch {}
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleepFn(Math.min(100, remainingMs));
  }
  return { ok: false, href: lastHref, error: lastError };
}
export async function navigateOpenTarget(targetId, sp, url, {
  createCdp = () => new CDP(),
  // The open path already passed the CDP_ISOLATED_ONLY gate; readiness polls skip the profile lookup.
  getWsUrlFn = discoverWsUrl,
  waitForOpenTargetUrlFn = waitForOpenTargetUrl,
  connectToSocketFn = connectToSocket,
  sendCommandFn = sendCommand,
  background = isBackgroundMode(),
  createdUrl = OPEN_CREATED_TARGET_URL,
  navigationRequested = openTargetNavigationRequested(createdUrl),
} = {}) {
  if (!url || url === 'about:blank') return { attempted: false, ok: true, reason: 'about:blank' };
  const attempts = [];
  // #644, same class as #339: do not poll for a condition this step has not caused.
  // A blank tab cannot already equal the requested URL, so look once and do not sleep.
  // One observation still accepts a target created directly at that URL. The 1500 ms
  // poll remains only when navigation was already requested and the URL has not landed.
  const initialTimeoutMs = navigationRequested ? 1500 : 0;
  const initialUrl = await waitForOpenTargetUrlFn(targetId, url, initialTimeoutMs);
  if (initialUrl.ok) {
    return { attempted: true, ok: true, method: 'Target.createTarget', href: initialUrl.href, error: null };
  }
  const cdp = createCdp();
  try {
    await cdp.connect(await getWsUrlFn());
    if (!background) await cdpDomains(cdp).Target.activateTarget( { targetId }, undefined, 5000).catch(() => {});
    const attached = await cdpDomains(cdp).Target.attachToTarget( { targetId, flatten: true }, undefined, 5000);
    const sid = attached.sessionId;
    await cdpDomains(cdp).Page.enable( {}, sid, 2000).catch(() => {});
    try {
      const nav = await cdpDomains(cdp).Page.navigate( { url }, sid, 5000);
      if (nav?.errorText) throw new Error(nav.errorText);
      return { attempted: true, ok: true, method: 'Page.navigate', error: null };
    } catch (e) {
      attempts.push({ method: 'Page.navigate', error: e.message || String(e) });
    }
    try {
      await cdpDomains(cdp).Runtime.evaluate( {
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

  const afterDirectUrl = await waitForOpenTargetUrlFn(targetId, url, 1500);
  if (afterDirectUrl.ok) {
    return { attempted: true, ok: true, method: 'Target.url-observed', href: afterDirectUrl.href, attempts, error: null };
  }

  let conn = null;
  try {
    conn = await connectToSocketFn(sp);
    const resp = await sendCommandFn(conn, { cmd: 'eval', args: [openNavigationScript(url)] });
    return {
      attempted: true,
      ok: resp.ok === true,
      method: 'daemon eval location.assign',
      attempts,
      error: resp.ok ? null : (resp.error || 'navigation failed'),
    };
  } catch (e) {
    attempts.push({ method: 'daemon eval location.assign', error: e.message || String(e) });
    const afterDaemonUrl = await waitForOpenTargetUrlFn(targetId, url, 1500);
    if (afterDaemonUrl.ok) {
      return { attempted: true, ok: true, method: 'Target.url-observed', href: afterDaemonUrl.href, attempts, error: null };
    }
    return { attempted: true, ok: false, method: 'daemon eval location.assign', attempts, error: e.message || String(e) };
  } finally {
    try { conn?.end(); } catch {}
  }
}
export function formatOpenNextPerceiveCommand(targetId) {
  return `Next: cdp text ${targetPrefixForDisplay(targetId)} --auto`;
}
export function formatOpenAttachWaitMessage(timeoutMs) {
  return `Waiting for "Allow debugging?" approval in Chrome... (up to ${formatDuration(timeoutMs)})`;
}
export function shouldAnnounceOpenAttachWait({ failedConnects = 0, elapsedMs = 0 } = {}) {
  return failedConnects >= 3 || elapsedMs >= 1000;
}
export function formatOpenReadyMessage(targetId, url = '') {
  const target = targetPrefixForDisplay(targetId);
  const lines = [
    'Tab ready — debugging approved.',
    `Target: ${target}${url ? `  ${url}` : ''}`,
    'Choose a ref from the perception below.',
    formatNextLine(`cdp click ${target} @ref`),
    `Then: cdp perceive ${target} --since-action`,
    `Report: cdp report ${target}`,
  ];
  return lines.join('\n');
}
export function buildOpenModel({ targetId, url = '', attached = false, autoPerceive = null, ready = null, navigation = null } = {}) {
  const target = targetPrefixForDisplay(targetId);
  const approved = attached === true;
  const defaultAutoPerceive = approved
    ? { attempted: false, ok: false, reason: 'not-run' }
    : { attempted: false, ok: false, reason: 'not-attached' };
  const autoPerceiveModel = autoPerceive || defaultAutoPerceive;
  const recommendation = approved && autoPerceiveModel.ok
    ? goldenPathActRecommendation(target, { fromPerceptionBelow: true })
    : approved
    ? goldenPathReadPageRecommendation(target)
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
export function formatOpenTimeoutMessage(targetId) {
  const target = targetPrefixForDisplay(targetId);
  return [
    'Timeout waiting for debugging approval. Tab created but daemon not connected.',
    `Target: ${target}`,
    'If Chrome asks "Allow debugging?", click Allow first.',
    formatOpenNextPerceiveCommand(targetId),
  ].join('\n');
}
export function formatOpenAutoPerceiveFailure(err, targetId) {
  const target = targetPrefixForDisplay(targetId);
  return [
    'Auto-perceive failed after the tab was attached.',
    formatCliError(err, { cmd: 'perceive', targetPrefix: target }),
  ].join('\n');
}
export function buildExactTargetSupervisorCandidates(pages, currentTargetId, browserIdentity) {
  return pages.map(page => ({
    resource: {
      schema: 'chrome-cdp-ex.resource-ref.v1',
      kind: 'page',
      id: `page-${createHash('sha256').update(String(page.targetId)).digest('hex').slice(0, 16)}`,
      revision: 0,
      capabilities: ['execute'],
      links: [{ relation: 'browser', ...browserIdentity }],
    },
    targetId: page.targetId,
    aliases: [],
    // Exact-target CLI routing does not need arbitrary page URLs. Keeping
    // them out avoids unrelated long/data URLs influencing target binding.
    url: '',
    current: page.targetId === currentTargetId,
    browser: browserIdentity,
  }));
}
export class CliExitSignal extends Error {
  constructor(code) {
    super(`CLI exit ${code}`);
    this.code = Number(code) || 0;
  }
}
export function isDeterministicTableContinuationResult(cmd, result) {
  if (cmd !== 'table' || typeof result !== 'string') return false;
  let model;
  try { model = JSON.parse(result); } catch { return false; }
  if (!model || typeof model !== 'object' || Array.isArray(model)
    || model.schema !== 'chrome-cdp-ex.table.v1'
    || !model.continuation || typeof model.continuation !== 'object'
    || Array.isArray(model.continuation)) return false;
  try {
    parseTableContinuationToken(model.continuation.token);
    return true;
  } catch {
    return false;
  }
}
