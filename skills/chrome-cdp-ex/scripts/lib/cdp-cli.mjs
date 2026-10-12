// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { parseExpectDownloadArgs } from './click-download.mjs';
import { classifyRawCdpMethod, commandResult, createCommandRegistry, defineCommandSpec } from './command-application.mjs';
import { inspectCommandDispatcher } from './command-dispatch.mjs';
import { COMMAND_SURFACE } from './command-surface.mjs';
import { formatNextClosingLines, formatNextLine } from './next-line.mjs';
import { goldenPathActRecommendation, goldenPathBrowserPermissionRecommendation, goldenPathReadPageRecommendation } from './perception-model.mjs';
import { assertSecretName } from './secrets.mjs';
import { parseTableArgs, parseTableContinuationToken } from './table-contract.mjs';
import { createHash } from 'crypto';
import { COMMANDS, DEFAULT_OPEN_ATTACH_TIMEOUT_MS, DEFAULT_OPEN_READY_TIMEOUT_MS, HALT_TRAILER_RE, OPEN_CREATED_TARGET_URL, STEP_HEADER_RE, USAGE } from './cdp-base.mjs';
import { formatDuration, isBlankPageUrl, parseCompactFormatArgs, parseFormatArgs } from './cdp-browser.mjs';
import { explicitBackgroundChoice, isBackgroundMode } from './cdp-core.mjs';
import { spawnDebugBrowserHelpDetails } from './cdp-doctor.mjs';
import { classifyCommandResultSemantics, commandMeta, flowStepHelpLines } from './cdp-flow.mjs';
import { clickFeedbackPolicy, isNamedClickQuery, namedClickActionTarget, parseActionabilityWaitArgs, pressHelpLines } from './cdp-input.mjs';
import { cdpDomains, evalScopeHelpLines } from './cdp-page.mjs';

export function helpStr() {
  return USAGE;
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
    const named = isNamedClickQuery(selector);
    const useJs = parsed.js || (named && !parsed.pointer);
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
    || (['console', 'diff-shot', 'elshot', 'fullshot', 'netlog', 'record', 'shot'].includes(command)
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
export function withKindOnLastNextLine(text, recoveryFor) {
  const lines = String(text).split('\n');
  const nextIndex = lines.findLastIndex(line => /^Next:/.test(line));
  const trailers = nextIndex < 0 ? lines : lines.slice(nextIndex + 1);
  if (nextIndex < 0) {
    const existingKind = [...lines].reverse().map(line => line.match(/^Kind: (\S+)/)?.[1]).find(Boolean) || null;
    return [...lines, ...formatNextClosingLines(recoveryFor(), { includeKind: true, existingKind })].join('\n');
  }
  if (!trailers.every(line => HALT_TRAILER_RE.test(line))) {
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
export function openNavigationScript(url) {
  return `(function() {
    location.assign(${JSON.stringify(url)});
    return JSON.stringify({ method: 'location.assign', target: ${JSON.stringify(url)} });
  })()`;
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
