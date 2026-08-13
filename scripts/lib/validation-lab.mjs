import { spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';

const REGISTRY_SCHEMA = 'chrome-cdp-ex.validation-registry.v1';
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHELL_RE = /[;&|`$<>\r\n]/;
const NETWORK_SCOPES = new Set(['none', 'loopback']);
const BROWSER_SCOPES = new Set(['none', 'disposable-local']);
const MUTATION_SCOPES = new Set(['none', 'task-created-files']);
const CLASSIFICATIONS = new Set(['product', 'flake', 'environment', 'scenario']);
const MIN_OUTPUT_BYTES = 64;
const CREDENTIAL_KEY_SUFFIX = '[a-z0-9_-]*(?:token|api[-_]?key|secret|password|passwd|passphrase)';
const CREDENTIAL_KEY = `(?:authorization|proxy-authorization|cookie|set-cookie|auth|key|session(?:id)?|${CREDENTIAL_KEY_SUFFIX})`;
const CREDENTIAL_ARG_FLAG_RE = new RegExp(`^-{1,2}${CREDENTIAL_KEY}$`, 'i');
const CREDENTIAL_ARG_ASSIGNMENT_RE = new RegExp(`^-{1,2}${CREDENTIAL_KEY}=`, 'i');
const SCENARIO_KEYS = new Set(['id', 'title', 'owner', 'tags', 'runner', 'expect', 'risk', 'classificationHints']);
const RUNNER_KEYS = new Set(['kind', 'entrypoint', 'args', 'sourceDigest']);
const EXPECT_KEYS = new Set(['exitCodes', 'stdoutIncludes', 'stderrIncludes']);
const RISK_KEYS = new Set(['units', 'timeoutMs', 'maxOutputBytes', 'network', 'browser', 'mutation', 'maxAttempts']);
const EVIDENCE_KEYS = new Set([
  'schema', 'redacted', 'scenario', 'scenarioDigest', 'registryDigest', 'ok', 'attempts',
  'classification', 'classificationConfidence', 'classificationReasons', 'fingerprint',
  'replay', 'duplicateOf', 'redactionCounts',
]);
const ATTEMPT_KEYS = new Set([
  'ok', 'status', 'signal', 'timedOut', 'outputOverflow', 'spawnError', 'cleanupError',
  'durationMs', 'failedPhase', 'failedCheck', 'failureMessage', 'stdout', 'stderr',
]);
const STREAM_KEYS = new Set([
  'preview', 'previewBytes', 'observedBytes', 'observedOmittedBytes', 'redactedOmittedBytes',
  'sha256', 'digestScope', 'truncated',
]);
const REDACTION_COUNT_KEYS = new Set(['credential', 'identifier', 'path', 'sensitiveKey']);
const CANONICAL_REPLAY = Object.freeze([
  'node', 'scripts/validation-lab.mjs', 'replay', '--bundle', '<bundle>', '--out-dir', '<out-dir>',
]);
const VALIDATION_SOURCE_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'README.md',
  'docs/reference.md',
  'scripts',
  'skills/chrome-cdp-ex/references/commands.md',
  'skills/chrome-cdp-ex/scripts',
]);

function validationSourcePaths(rootDir) {
  let packageModel;
  try {
    packageModel = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
  } catch (error) {
    fail('sourceIdentity.package.json', `must be valid JSON: ${error.message}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(packageModel?.version || '')) {
    fail('sourceIdentity.package.json.version', 'must be a semantic version');
  }
  return [...VALIDATION_SOURCE_PATHS, `docs/contracts/v${packageModel.version}`];
}
const MAX_SOURCE_IDENTITY_FILES = 1024;
const MAX_SOURCE_IDENTITY_ENTRIES = 2048;
const MAX_SOURCE_IDENTITY_BYTES = 32 * 1024 * 1024;

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function assertObject(value, path) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(path, 'must be an object');
}

function assertOnlyKeys(value, allowed, path) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, 'is not allowed');
}

function positiveInteger(value, path) {
  if (!Number.isInteger(value) || value <= 0) fail(path, 'must be a positive integer');
}

function stringArray(value, path, { nonempty = false } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) fail(path, 'must be a non-empty array');
  value.forEach((entry, index) => {
    if (typeof entry !== 'string') fail(`${path}[${index}]`, 'must be a string');
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isOutside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function assertResolvedContained(rootPath, candidatePath, label, expectedType) {
  const lexicalRoot = resolve(rootPath);
  const lexicalCandidate = resolve(candidatePath);
  if (isOutside(lexicalRoot, lexicalCandidate)) fail(label, 'must not escape allowed root');
  let rootReal;
  try {
    rootReal = realpathSync(lexicalRoot);
  } catch {
    fail(label, 'allowed root does not exist');
  }
  const rel = relative(lexicalRoot, lexicalCandidate);
  let cursor = lexicalRoot;
  for (const component of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, component);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch {
      fail(label, 'path does not exist');
    }
    if (stat.isSymbolicLink()) fail(label, 'must not traverse a symlink');
  }
  let candidateReal;
  try {
    candidateReal = realpathSync(lexicalCandidate);
  } catch {
    fail(label, 'path does not exist');
  }
  if (isOutside(rootReal, candidateReal)) fail(label, 'resolves outside allowed root');
  const stat = statSync(candidateReal);
  if (expectedType === 'file' && !stat.isFile()) fail(label, 'must reference an existing file');
  if (expectedType === 'directory' && !stat.isDirectory()) fail(label, 'must reference an existing directory');
  return candidateReal;
}

export function digestValue(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function collectSourceIdentityFiles(rootDir, candidatePath, state) {
  const absolute = resolve(rootDir, candidatePath);
  if (!existsSync(absolute)) fail(`sourceIdentity.${candidatePath}`, 'required source does not exist');
  if (state.seen.has(absolute)) return;
  state.seen.add(absolute);
  state.entries += 1;
  if (state.entries > MAX_SOURCE_IDENTITY_ENTRIES) fail('sourceIdentity', 'exceeds entry-count bound');
  assertResolvedContained(rootDir, absolute, `sourceIdentity.${candidatePath}`, null);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) fail(`sourceIdentity.${candidatePath}`, 'must not traverse a symlink');
  if (stat.isFile()) {
    if (state.files.length >= MAX_SOURCE_IDENTITY_FILES) fail('sourceIdentity', 'exceeds file-count bound');
    state.totalBytes += stat.size;
    if (state.totalBytes > MAX_SOURCE_IDENTITY_BYTES) fail('sourceIdentity', 'exceeds byte bound');
    state.files.push(absolute);
    return;
  }
  if (!stat.isDirectory()) fail(`sourceIdentity.${candidatePath}`, 'must be a file or directory');
  const directory = opendirSync(absolute);
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      const child = relative(rootDir, resolve(absolute, entry.name));
      collectSourceIdentityFiles(rootDir, child, state);
    }
  } finally {
    directory.closeSync();
  }
}

export function buildValidationSourceDigest({ rootDir, entrypoint }) {
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir)) fail('sourceIdentity.rootDir', 'must be an absolute path');
  if (typeof entrypoint !== 'string' || entrypoint === '' || isAbsolute(entrypoint)) {
    fail('sourceIdentity.entrypoint', 'must be repository-relative');
  }
  const state = { entries: 0, files: [], seen: new Set(), totalBytes: 0 };
  for (const candidatePath of new Set([entrypoint, ...validationSourcePaths(rootDir)])) {
    collectSourceIdentityFiles(rootDir, candidatePath, state);
  }
  const unique = [...state.files].sort((left, right) => {
    const a = relative(rootDir, left).split(sep).join('/');
    const b = relative(rootDir, right).split(sep).join('/');
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (unique.length === 0) fail('sourceIdentity', 'must include the runner entrypoint');
  let actualBytes = 0;
  const files = [];
  for (const file of unique) {
    const bytes = readFileSync(file);
    actualBytes += bytes.length;
    if (actualBytes > MAX_SOURCE_IDENTITY_BYTES) fail('sourceIdentity', 'exceeds byte bound');
    files.push({
      path: relative(rootDir, file).split(sep).join('/'),
      bytes: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
  }
  return digestValue({ schema: 'chrome-cdp-ex.validation-source.v1', files });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateScenario(input, index, rootDir) {
  const base = `scenarios[${index}]`;
  assertObject(input, base);
  assertOnlyKeys(input, SCENARIO_KEYS, base);
  if (typeof input.id !== 'string' || !ID_RE.test(input.id)) fail(`${base}.id`, 'must be a stable kebab-case id');
  for (const key of ['title', 'owner']) {
    if (typeof input[key] !== 'string' || input[key].trim() === '') fail(`${base}.${key}`, 'must be a non-empty string');
  }
  stringArray(input.tags, `${base}.tags`);
  input.tags.forEach((tag, tagIndex) => {
    if (!ID_RE.test(tag)) fail(`${base}.tags[${tagIndex}]`, 'must be kebab-case');
  });
  if (new Set(input.tags).size !== input.tags.length) fail(`${base}.tags`, 'must not contain duplicates');

  assertObject(input.runner, `${base}.runner`);
  assertOnlyKeys(input.runner, RUNNER_KEYS, `${base}.runner`);
  if (input.runner.kind !== 'node') fail(`${base}.runner.kind`, 'must be node');
  const entrypoint = input.runner.entrypoint;
  if (typeof entrypoint !== 'string' || entrypoint === '' || isAbsolute(entrypoint)) {
    fail(`${base}.runner.entrypoint`, 'must be repository-relative');
  }
  if (entrypoint.split(/[\\/]/).includes('..')) fail(`${base}.runner.entrypoint`, 'must not escape the repository');
  const resolvedEntrypoint = resolve(rootDir, entrypoint);
  if (isOutside(resolve(rootDir), resolvedEntrypoint)) fail(`${base}.runner.entrypoint`, 'must stay inside the repository');
  assertResolvedContained(rootDir, resolvedEntrypoint, `${base}.runner.entrypoint`, 'file');
  const sourceDigest = buildValidationSourceDigest({ rootDir, entrypoint });
  if (input.runner.sourceDigest !== undefined && input.runner.sourceDigest !== sourceDigest) {
    fail(`${base}.runner.sourceDigest`, 'does not match current source');
  }
  stringArray(input.runner.args, `${base}.runner.args`);
  input.runner.args.forEach((arg, argIndex) => {
    if (SHELL_RE.test(arg)) fail(`${base}.runner.args[${argIndex}]`, 'contains forbidden shell syntax');
    if (CREDENTIAL_ARG_FLAG_RE.test(arg) || CREDENTIAL_ARG_ASSIGNMENT_RE.test(arg)) {
      fail(`${base}.runner.args[${argIndex}]`, 'credential-bearing arguments are forbidden');
    }
  });

  assertObject(input.expect, `${base}.expect`);
  assertOnlyKeys(input.expect, EXPECT_KEYS, `${base}.expect`);
  if (!Array.isArray(input.expect.exitCodes) || input.expect.exitCodes.length === 0) fail(`${base}.expect.exitCodes`, 'must be a non-empty array');
  input.expect.exitCodes.forEach((code, codeIndex) => {
    if (!Number.isInteger(code) || code < 0) fail(`${base}.expect.exitCodes[${codeIndex}]`, 'must be a non-negative integer');
  });
  for (const key of ['stdoutIncludes', 'stderrIncludes']) {
    if (input.expect[key] !== undefined) stringArray(input.expect[key], `${base}.expect.${key}`);
  }

  assertObject(input.risk, `${base}.risk`);
  assertOnlyKeys(input.risk, RISK_KEYS, `${base}.risk`);
  for (const key of ['units', 'timeoutMs', 'maxOutputBytes', 'maxAttempts']) positiveInteger(input.risk[key], `${base}.risk.${key}`);
  if (input.risk.maxOutputBytes < MIN_OUTPUT_BYTES) {
    fail(`${base}.risk.maxOutputBytes`, `must be at least ${MIN_OUTPUT_BYTES}`);
  }
  if (!NETWORK_SCOPES.has(input.risk.network)) fail(`${base}.risk.network`, 'must be none or loopback');
  if (!BROWSER_SCOPES.has(input.risk.browser)) fail(`${base}.risk.browser`, 'must be none or disposable-local');
  if (!MUTATION_SCOPES.has(input.risk.mutation)) fail(`${base}.risk.mutation`, 'must be none or task-created-files');
  if (input.risk.browser === 'none' && input.risk.network === 'loopback') fail(`${base}.risk.network`, 'loopback requires disposable-local browser scope');
  if (input.risk.browser === 'disposable-local' && input.risk.network !== 'loopback') fail(`${base}.risk.network`, 'disposable-local requires loopback scope');

  if (input.classificationHints !== undefined) {
    stringArray(input.classificationHints, `${base}.classificationHints`);
    input.classificationHints.forEach((hint, hintIndex) => {
      if (!CLASSIFICATIONS.has(hint)) fail(`${base}.classificationHints[${hintIndex}]`, 'is unknown');
    });
  }

  return {
    id: input.id,
    title: input.title,
    owner: input.owner,
    tags: [...input.tags].sort(),
    runner: { kind: 'node', entrypoint, args: [...input.runner.args], sourceDigest },
    expect: {
      exitCodes: [...new Set(input.expect.exitCodes)].sort((a, b) => a - b),
      ...(input.expect.stdoutIncludes ? { stdoutIncludes: [...input.expect.stdoutIncludes] } : {}),
      ...(input.expect.stderrIncludes ? { stderrIncludes: [...input.expect.stderrIncludes] } : {}),
    },
    risk: { ...input.risk },
    ...(input.classificationHints ? { classificationHints: [...input.classificationHints].sort() } : {}),
  };
}

export function validateScenarioRegistry(input, { rootDir } = {}) {
  if (typeof rootDir !== 'string' || rootDir.trim() === '' || !isAbsolute(rootDir)) fail('rootDir', 'must be an absolute repository path');
  assertObject(input, 'registry');
  assertOnlyKeys(input, new Set(['schema', 'scenarios']), 'registry');
  if (input.schema !== REGISTRY_SCHEMA) fail('registry.schema', `must equal ${REGISTRY_SCHEMA}`);
  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0) fail('registry.scenarios', 'must be a non-empty array');
  const scenarios = input.scenarios.map((item, index) => validateScenario(item, index, rootDir));
  const seen = new Set();
  for (const entry of scenarios) {
    if (seen.has(entry.id)) fail('registry.scenarios', `duplicate scenario id ${entry.id}`);
    seen.add(entry.id);
  }
  return deepFreeze({ schema: REGISTRY_SCHEMA, scenarios: scenarios.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
}

function validateBudget(budget) {
  assertObject(budget, 'budget');
  for (const key of ['maxRiskUnits', 'maxDurationMs', 'maxOutputBytes', 'maxScenarios']) positiveInteger(budget[key], `budget.${key}`);
  if (budget.allowLive !== undefined && typeof budget.allowLive !== 'boolean') fail('budget.allowLive', 'must be boolean');
}

export function planValidationRun(registry, selection = { mode: 'default' }, budget) {
  validateBudget(budget);
  if (!registry || registry.schema !== REGISTRY_SCHEMA || !Array.isArray(registry.scenarios)) fail('registry', 'must be validated');
  const explicit = Array.isArray(selection.ids);
  const requested = explicit ? [...new Set(selection.ids)].sort() : null;
  if (!explicit && selection.mode !== 'default') fail('selection.mode', 'must be default');
  const byId = new Map(registry.scenarios.map(entry => [entry.id, entry]));
  if (explicit) {
    for (const id of requested) if (!byId.has(id)) fail('selection.ids', `unknown scenario ${id}`);
  }
  const selected = registry.scenarios.filter(entry => explicit ? requested.includes(entry.id) : entry.tags.includes('default'));
  const skipped = registry.scenarios
    .filter(entry => !selected.includes(entry))
    .map(entry => ({ id: entry.id, reason: explicit ? 'not explicitly selected' : 'not tagged default' }));
  for (const entry of selected) {
    const live = entry.risk.browser !== 'none' || entry.risk.network !== 'none';
    if (live && budget.allowLive !== true) fail(`scenario ${entry.id}`, 'live requires allowLive');
  }
  const totals = selected.reduce((result, entry) => ({
    scenarios: result.scenarios + 1,
    riskUnits: result.riskUnits + entry.risk.units * entry.risk.maxAttempts,
    durationMs: result.durationMs + entry.risk.timeoutMs * entry.risk.maxAttempts,
    outputBytes: result.outputBytes + entry.risk.maxOutputBytes * entry.risk.maxAttempts,
  }), { scenarios: 0, riskUnits: 0, durationMs: 0, outputBytes: 0 });
  const checks = [
    ['maxRiskUnits', totals.riskUnits],
    ['maxDurationMs', totals.durationMs],
    ['maxOutputBytes', totals.outputBytes],
    ['maxScenarios', totals.scenarios],
  ];
  for (const [key, actual] of checks) if (actual > budget[key]) fail(`budget.${key}`, `planned ${actual} exceeds ${budget[key]}`);
  return deepFreeze({
    schema: 'chrome-cdp-ex.validation-plan.v1',
    registryDigest: digestValue(registry),
    allowLive: budget.allowLive === true,
    selected,
    skipped,
    totals,
  });
}

const SENSITIVE_KEY_RE = new RegExp(`^${CREDENTIAL_KEY}$`, 'i');
const SECRET_QUERY_RE = /([?&](?:access_token|api_key|auth|authorization|cookie|key|password|secret|session|token)=)[^&#\s]*/gi;
const AUTH_VALUE_RE = /\b((?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/gi;
const COOKIE_VALUE_RE = /\b((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]*/gi;
const CREDENTIAL_ASSIGNMENT = `(?:"${CREDENTIAL_KEY}"|'${CREDENTIAL_KEY}'|${CREDENTIAL_KEY})[\\t ]*[:=][\\t ]*`;
const CREDENTIAL_QUOTED_VALUE = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')`;
const CREDENTIAL_QUOTED_VALUE_RE = new RegExp(`(^|[^a-z0-9_-])(${CREDENTIAL_ASSIGNMENT})${CREDENTIAL_QUOTED_VALUE}`, 'gim');
const CREDENTIAL_UNTERMINATED_VALUE_RE = new RegExp(`(^|[^a-z0-9_-])(${CREDENTIAL_ASSIGNMENT})["'][^\\r\\n]*`, 'gim');
const CREDENTIAL_HEADER_VALUE_RE = new RegExp(`(^|[^a-z0-9_-])(${CREDENTIAL_ASSIGNMENT})[^\\r\\n,;}\\]&#]*`, 'gim');
const CREDENTIAL_REDACTED_SUFFIX_RE = new RegExp(`(^|[^a-z0-9_?&-])(${CREDENTIAL_ASSIGNMENT})<redacted>[^\\r\\n]+`, 'gim');
const CREDENTIAL_HEADER_DETECT_RE = new RegExp(`(^|[^a-z0-9_?&-])${CREDENTIAL_ASSIGNMENT}(?![\\t ]*<redacted>[\\t ]*$)[^\\r\\n,;}\\]&#]+`, 'im');
const CREDENTIAL_UNTERMINATED_VALUE_DETECT_RE = new RegExp(`(^|[^a-z0-9_-])${CREDENTIAL_ASSIGNMENT}["'][^\\r\\n]*`, 'im');
const CLI_CREDENTIAL_VALUE_RE = new RegExp(`(^|[^a-z0-9_-])(-{1,2}${CREDENTIAL_KEY})([\\t ]+)[^\\r\\n]*`, 'gim');
const CLI_CREDENTIAL_VALUE_DETECT_RE = new RegExp(`(^|[^a-z0-9_-])-{1,2}${CREDENTIAL_KEY}[\\t ]+(?![\\t ]*<redacted>[\\t ]*$)[^\\r\\n]+`, 'im');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceCount(text, pattern, replacement) {
  let count = 0;
  return {
    value: text.replace(pattern, (...args) => {
      count += 1;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    }),
    count,
  };
}

export function redactEvidence(value, context = {}) {
  const counts = { credential: 0, identifier: 0, path: 0, sensitiveKey: 0 };

  const redactString = input => {
    let output = input;
    const boundaryCredential = replaceCount(
      output,
      /((?:(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+|(?:set-cookie|cookie)\s*[:=]\s*|[?&](?:access_token|api_key|auth|authorization|cookie|key|password|secret|session|token)=)[^\r\n]*)(\n<\d+ bytes omitted>\n)([^\s&#,;]*)/gi,
      (_match, prefix, marker, continuation) => `${prefix}${marker}${continuation ? '<redacted-continuation>' : ''}`,
    );
    output = boundaryCredential.value;
    counts.credential += boundaryCredential.count;
    for (const [pattern, replacement, kind] of [
      [SECRET_QUERY_RE, (_match, prefix) => `${prefix}<redacted>`, 'credential'],
      [AUTH_VALUE_RE, (_match, prefix) => `${prefix}<redacted>`, 'credential'],
      [COOKIE_VALUE_RE, (_match, prefix) => `${prefix}<redacted>`, 'credential'],
      [CREDENTIAL_QUOTED_VALUE_RE, (_match, boundary, prefix) => `${boundary}${prefix}<redacted>`, 'credential'],
      [CREDENTIAL_UNTERMINATED_VALUE_RE, (_match, boundary, prefix) => `${boundary}${prefix}<redacted>`, 'credential'],
      [CREDENTIAL_HEADER_VALUE_RE, (_match, boundary, prefix) => `${boundary}${prefix}<redacted>`, 'credential'],
      [CREDENTIAL_REDACTED_SUFFIX_RE, (_match, boundary, prefix) => `${boundary}${prefix}<redacted>`, 'credential'],
      [CLI_CREDENTIAL_VALUE_RE, (_match, boundary, flag, spacing) => `${boundary}${flag}${spacing}<redacted>`, 'credential'],
    ]) {
      const changed = replaceCount(output, pattern, replacement);
      output = changed.value;
      counts[kind] += changed.count;
    }
    const paths = [context.homeDir, ...(context.homeDirs || []), ...(context.tempDirs || []), ...(context.paths || [])]
      .filter(item => typeof item === 'string' && item.length > 1)
      .sort((left, right) => right.length - left.length);
    for (const path of paths) {
      const changed = replaceCount(output, new RegExp(escapeRegExp(path), 'g'), '<redacted-path>');
      output = changed.value;
      counts.path += changed.count;
    }
    for (const pattern of [
      /\/Users\/[^\s'"<>]+/g,
      /\/home\/[^\s'"<>]+/g,
      /[A-Za-z]:\\Users\\[^\s'"<>]+/g,
      /\/(?:private\/)?tmp\/[^\s'"<>]+/g,
    ]) {
      const changed = replaceCount(output, pattern, '<redacted-path>');
      output = changed.value;
      counts.path += changed.count;
    }
    for (const [items, label, patternFor] of [
      [context.ports || [], 'port', item => new RegExp(`(?<=[:=])${escapeRegExp(String(item))}\\b`, 'g')],
      [context.targetIds || [], 'target', item => new RegExp(escapeRegExp(String(item)), 'g')],
      [context.runIds || [], 'run', item => new RegExp(escapeRegExp(String(item)), 'g')],
    ]) {
      for (const item of items) {
        const changed = replaceCount(output, patternFor(item), `<redacted-${label}>`);
        output = changed.value;
        counts.identifier += changed.count;
      }
    }
    for (const [pattern, replacement] of [
      [/\b(targetId|target_id)\s*[:=]\s*[A-Za-z0-9_-]+/gi, '$1=<redacted-target>'],
      [/\b(port)\s*[:=]\s*\d{2,5}\b/gi, '$1=<redacted-port>'],
      [/\b(pid)\s*[:=]\s*\d+\b/gi, '$1=<redacted-pid>'],
      [/\b(runId|run_id)\s*[:=]\s*[A-Za-z0-9_-]+/gi, '$1=<redacted-run>'],
    ]) {
      const changed = replaceCount(output, pattern, (...args) => replacement.replace('$1', args[1]));
      output = changed.value;
      counts.identifier += changed.count;
    }
    return output;
  };

  const visit = input => {
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, child]) => {
        if (SENSITIVE_KEY_RE.test(key)) {
          counts.sensitiveKey += 1;
          return [key, '<redacted>'];
        }
        return [key, visit(child)];
      }));
    }
    return typeof input === 'string' ? redactString(input) : input;
  };

  return deepFreeze({ value: visit(value), counts });
}

function decodePrefix(buffer, maxBytes) {
  for (let length = Math.min(buffer.length, maxBytes); length >= 0; length -= 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      // Shrink to the previous UTF-8 boundary.
    }
  }
  return '';
}

function decodeSuffix(buffer, maxBytes) {
  const start = Math.max(0, buffer.length - maxBytes);
  for (let offset = start; offset <= buffer.length; offset += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(offset));
    } catch {
      // Advance to the next UTF-8 boundary.
    }
  }
  return '';
}

export function boundedStream(value, maxBytes) {
  positiveInteger(maxBytes, 'maxBytes');
  const text = String(value ?? '');
  const buffer = Buffer.from(text, 'utf8');
  const sha256 = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
  if (buffer.length <= maxBytes) {
    return deepFreeze({ preview: text, bytes: buffer.length, sha256, truncated: false, omittedBytes: 0 });
  }
  if (maxBytes < MIN_OUTPUT_BYTES) fail('maxBytes', `must be at least ${MIN_OUTPUT_BYTES} when truncation is required`);
  let marker = '\n<bytes omitted>\n';
  let available = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let head = decodePrefix(buffer, Math.ceil(available / 2));
  let tail = decodeSuffix(buffer, Math.floor(available / 2));
  let omittedBytes = buffer.length - Buffer.byteLength(head) - Buffer.byteLength(tail);
  marker = `\n<${omittedBytes} bytes omitted>\n`;
  available = Math.max(0, maxBytes - Buffer.byteLength(marker));
  head = decodePrefix(buffer, Math.ceil(available / 2));
  tail = decodeSuffix(buffer, Math.floor(available / 2));
  omittedBytes = buffer.length - Buffer.byteLength(head) - Buffer.byteLength(tail);
  marker = `\n<${omittedBytes} bytes omitted>\n`;
  while (Buffer.byteLength(head + marker + tail) > maxBytes && tail) {
    tail = decodeSuffix(Buffer.from(tail), Buffer.byteLength(tail) - 1);
    omittedBytes = buffer.length - Buffer.byteLength(head) - Buffer.byteLength(tail);
    marker = `\n<${omittedBytes} bytes omitted>\n`;
  }
  return deepFreeze({
    preview: head + marker + tail,
    head,
    tail,
    bytes: buffer.length,
    sha256,
    truncated: true,
    omittedBytes,
  });
}

function createStreamCollector(maxBytes) {
  positiveInteger(maxBytes, 'maxBytes');
  if (maxBytes < MIN_OUTPUT_BYTES) fail('maxBytes', `must be at least ${MIN_OUTPUT_BYTES}`);
  let bytes = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  const tailLimit = Math.max(1, Math.floor(maxBytes / 2));
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (head.length < maxBytes) {
        head = Buffer.concat([head, buffer.subarray(0, maxBytes - head.length)]);
      }
      tail = Buffer.concat([tail, buffer]);
      if (tail.length > tailLimit) tail = tail.subarray(tail.length - tailLimit);
    },
    get bytes() {
      return bytes;
    },
    snapshot() {
      if (bytes <= maxBytes) return boundedStream(head.toString('utf8'), maxBytes);
      let marker = '\n<bytes omitted>\n';
      let available = Math.max(0, maxBytes - Buffer.byteLength(marker));
      let headText = decodePrefix(head, Math.ceil(available / 2));
      let tailText = decodeSuffix(tail, Math.floor(available / 2));
      let omittedBytes = bytes - Buffer.byteLength(headText) - Buffer.byteLength(tailText);
      marker = `\n<${omittedBytes} bytes omitted>\n`;
      available = Math.max(0, maxBytes - Buffer.byteLength(marker));
      headText = decodePrefix(head, Math.ceil(available / 2));
      tailText = decodeSuffix(tail, Math.floor(available / 2));
      omittedBytes = bytes - Buffer.byteLength(headText) - Buffer.byteLength(tailText);
      marker = `\n<${omittedBytes} bytes omitted>\n`;
      while (Buffer.byteLength(headText + marker + tailText) > maxBytes && tailText) {
        tailText = decodeSuffix(Buffer.from(tailText), Buffer.byteLength(tailText) - 1);
        omittedBytes = bytes - Buffer.byteLength(headText) - Buffer.byteLength(tailText);
        marker = `\n<${omittedBytes} bytes omitted>\n`;
      }
      const preview = headText + marker + tailText;
      return deepFreeze({
        preview,
        head: headText,
        tail: tailText,
        bytes,
        sha256: `sha256:${createHash('sha256').update(preview).digest('hex')}`,
        truncated: true,
        omittedBytes,
      });
    },
  };
}

export function normalizeFailure(observation) {
  const input = typeof observation === 'string' ? { message: observation } : observation;
  if (!input || typeof input.message !== 'string') fail('observation.message', 'must be a string');
  let output = input.message.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const paths = [input.homeDir, ...(input.homeDirs || []), ...(input.tempDirs || []), ...(input.paths || [])]
    .filter(item => typeof item === 'string' && item.length > 1)
    .sort((left, right) => right.length - left.length);
  for (const path of paths) output = output.replace(new RegExp(escapeRegExp(path), 'g'), path === input.homeDir ? '<home>' : '<tmp>');
  return output
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/\/Users\/[^/\s]+/g, '<home>')
    .replace(/\/home\/[^/\s]+/g, '<home>')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '<home>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(targetId|target_id)\s*[:=]\s*[A-Za-z0-9_-]+/gi, '$1=<target>')
    .replace(/\b(port)\s*[:=]\s*\d{2,5}\b/gi, '$1=<port>')
    .replace(/(?<=https?:\/\/(?:127\.0\.0\.1|localhost)):\d{2,5}\b/gi, ':<port>')
    .replace(/\b(pid)\s*[:=]\s*\d+\b/gi, '$1=<pid>')
    .replace(/(?<=\.[cm]?[jt]s):\d+:\d+\b/g, ':<line>:<col>')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function buildFailureFingerprint(input) {
  assertObject(input, 'fingerprint');
  for (const key of ['scenarioId', 'scenarioDigest', 'failedPhase', 'failedCheck', 'normalizedFailure']) {
    if (typeof input[key] !== 'string' || input[key] === '') fail(key, 'is required');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.scenarioDigest)) fail('scenarioDigest', 'must be a SHA-256 digest');
  const identity = {
    schema: 'chrome-cdp-ex.validation-fingerprint.v1',
    scenarioId: input.scenarioId,
    scenarioDigest: input.scenarioDigest,
    failedPhase: input.failedPhase,
    failedCheck: input.failedCheck,
    exitCode: input.exitCode ?? null,
    signal: input.signal ?? null,
    normalizedFailure: input.normalizedFailure,
  };
  return digestValue(identity);
}

function allowedEnvironment(sandboxDir, overrides = {}, nodeEnv = 'test') {
  const env = {
    FORCE_COLOR: '0',
    HOME: sandboxDir,
    LANG: 'C',
    LC_ALL: 'C',
    NODE_ENV: nodeEnv,
    NO_COLOR: '1',
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: sandboxDir,
    XDG_RUNTIME_DIR: sandboxDir,
  };
  for (const key of ['USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING', 'DISPLAY', 'WAYLAND_DISPLAY']) {
    if (typeof process.env[key] === 'string' && process.env[key]) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!['CDP_BENCH_PORT', 'CDP_BENCH_HTTP_PORT'].includes(key)) fail(`env.${key}`, 'is not allowlisted');
    env[key] = String(value);
  }
  return env;
}

export function runBoundedProcess(invocation) {
  return new Promise(resolveProcess => {
    const startedAt = Date.now();
    const stdout = createStreamCollector(invocation.maxOutputBytes);
    const stderr = createStreamCollector(invocation.maxOutputBytes);
    let outputOverflow = false;
    let timedOut = false;
    let spawnError = null;
    let cleanupError = null;
    let settled = false;
    let child;
    let timer = null;
    let forceTimer = null;
    let settleTimer = null;
    const killGraceMs = Number.isInteger(invocation.killGraceMs) && invocation.killGraceMs > 0
      ? invocation.killGraceMs
      : 1000;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      resolveProcess({
        status,
        signal: signal || null,
        stdout: stdout.snapshot(),
        stderr: stderr.snapshot(),
        timedOut,
        outputOverflow,
        spawnError,
        cleanupError,
        durationMs: Date.now() - startedAt,
      });
    };
    const stopChild = signal => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch (error) {
        cleanupError = error.message;
      }
    };
    const beginShutdown = () => {
      stopChild('SIGTERM');
      if (!forceTimer) {
        forceTimer = setTimeout(() => stopChild('SIGKILL'), killGraceMs);
        settleTimer = setTimeout(() => {
          cleanupError ||= 'child did not close after SIGKILL';
          finish(null, 'SIGKILL');
        }, killGraceMs * 2);
      }
    };
    try {
      const spawnImpl = invocation.spawnImpl || spawn;
      child = spawnImpl(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      spawnError = error.message;
      resolveProcess({
        status: null, signal: null, stdout: '', stderr: '', timedOut: false,
        outputOverflow: false, spawnError, cleanupError: null, durationMs: Date.now() - startedAt,
      });
      return;
    }
    child.stdout?.on('data', chunk => {
      stdout.append(chunk);
      if (stdout.bytes + stderr.bytes > invocation.maxOutputBytes) outputOverflow = true;
      if (outputOverflow) beginShutdown();
    });
    child.stderr?.on('data', chunk => {
      stderr.append(chunk);
      if (stdout.bytes + stderr.bytes > invocation.maxOutputBytes) outputOverflow = true;
      if (outputOverflow) beginShutdown();
    });
    child.once('error', error => {
      spawnError = error.message;
    });
    child.once('close', finish);
    timer = setTimeout(() => {
      timedOut = true;
      beginShutdown();
    }, invocation.timeoutMs);
  });
}

function evaluateAttempt(result, scenario) {
  let failedPhase = null;
  let failedCheck = null;
  let failureMessage = '';
  const setFailure = (phase, check, message) => {
    if (failedCheck === null) {
      failedPhase = phase;
      failedCheck = check;
      failureMessage = message;
    }
  };
  if (result.spawnError) setFailure('execution', 'spawn', result.spawnError);
  if (result.timedOut) setFailure('execution', 'timeout', `timed out after ${scenario.risk.timeoutMs}ms`);
  if (result.outputOverflow) setFailure('execution', 'output', `output exceeded ${scenario.risk.maxOutputBytes} bytes`);
  if (result.signal) setFailure('execution', 'signal', `terminated by ${result.signal}`);
  if (!scenario.expect.exitCodes.includes(result.status)) setFailure('assertion', 'exitCodes', `expected exit ${scenario.expect.exitCodes.join('|')}, received ${result.status}`);
  for (const [streamName, checks] of [
    ['stdout', scenario.expect.stdoutIncludes || []],
    ['stderr', scenario.expect.stderrIncludes || []],
  ]) {
    checks.forEach((needle, index) => {
      const observed = typeof result[streamName] === 'string'
        ? result[streamName]
        : result[streamName]?.preview || '';
      if (!observed.includes(needle)) {
        setFailure('assertion', `${streamName}Includes[${index}]`, `${streamName} did not include ${JSON.stringify(needle)}`);
      }
    });
  }
  if (result.cleanupError) setFailure('cleanup', 'cleanup', result.cleanupError);
  const stdout = typeof result.stdout === 'string'
    ? boundedStream(result.stdout, scenario.risk.maxOutputBytes)
    : result.stdout;
  const stderr = typeof result.stderr === 'string'
    ? boundedStream(result.stderr, scenario.risk.maxOutputBytes)
    : result.stderr;
  return deepFreeze({
    ok: failedCheck === null,
    status: result.status ?? null,
    signal: result.signal || null,
    timedOut: result.timedOut === true,
    outputOverflow: result.outputOverflow === true,
    spawnError: result.spawnError || null,
    cleanupError: result.cleanupError || null,
    durationMs: Math.max(0, Number(result.durationMs) || 0),
    failedPhase,
    failedCheck,
    failureMessage,
    stdout,
    stderr,
  });
}

export async function executeScenario(scenario, context = {}) {
  if (typeof context.rootDir !== 'string' || !isAbsolute(context.rootDir)) fail('rootDir', 'must be absolute');
  if (typeof context.sandboxDir !== 'string' || !isAbsolute(context.sandboxDir)) fail('sandboxDir', 'must be absolute');
  const runProcess = context.runProcess || runBoundedProcess;
  const attempts = [];
  for (let attempt = 0; attempt < scenario.risk.maxAttempts; attempt += 1) {
    const result = await runProcess({
      executable: process.execPath,
      args: [resolve(context.rootDir, scenario.runner.entrypoint), ...scenario.runner.args],
      cwd: context.rootDir,
      env: allowedEnvironment(
        context.sandboxDir,
        context.env || {},
        scenario.risk.browser === 'disposable-local' ? 'production' : 'test',
      ),
      shell: false,
      detached: false,
      timeoutMs: scenario.risk.timeoutMs,
      maxOutputBytes: scenario.risk.maxOutputBytes,
      killGraceMs: scenario.risk.browser === 'disposable-local' ? 5000 : 1000,
    });
    const evaluated = evaluateAttempt(result, scenario);
    attempts.push(evaluated);
    if (evaluated.ok) break;
  }
  return deepFreeze({ ok: attempts.at(-1)?.ok === true, attempts });
}

function failureIdentity(scenario, scenarioDigest, attempt) {
  const normalizedFailure = normalizeFailure({ message: [
    attempt.failureMessage,
    attempt.stderr.preview,
    attempt.stdout.preview,
  ].filter(Boolean).join('\n') });
  return {
    scenarioId: scenario.id,
    scenarioDigest,
    failedPhase: attempt.failedPhase || 'unknown',
    failedCheck: attempt.failedCheck || 'unknown',
    exitCode: attempt.status,
    signal: attempt.signal,
    normalizedFailure,
  };
}

function attemptText(attempt) {
  return [
    attempt.spawnError,
    attempt.cleanupError,
    attempt.failureMessage,
    attempt.stderr?.preview,
    attempt.stdout?.preview,
  ].filter(Boolean).join('\n');
}

export function classifyFailure(attempts, scenario = {}) {
  if (!Array.isArray(attempts)) fail('attempts', 'must be an array');
  const failed = attempts.filter(attempt => attempt?.ok === false);
  if (failed.length === 0) fail('attempts', 'no failed attempt was observed');
  const text = failed.map(attemptText).join('\n');
  const scenarioFailure = failed.some(attempt =>
    ['policy', 'scenario'].includes(attempt.failedPhase)
    || /^(?:allowLive|registry|runner\.|scenario\.)/.test(attempt.failedCheck || ''));
  if (scenarioFailure) {
    return deepFreeze({ classification: 'scenario', confidence: 'high', reasons: ['scenario contract or policy rejected execution'] });
  }
  const environmentPattern = /\b(?:EADDRINUSE|EACCES|ECONNREFUSED|EMFILE|ENFILE|ENOSPC|ENOMEM|ENOENT)\b|CDP_REACHABILITY:|no supported (?:Chrome|Edge|Brave|browser)|no Chrome for Testing browser binary found|browser (?:is not|not) (?:available|reachable)|connection refused|resource temporarily unavailable|address already in use/i;
  const environmentFailure = environmentPattern.test(text)
    || failed.some(attempt => attempt.cleanupError || attempt.failedCheck === 'cleanup');
  if (environmentFailure) {
    return deepFreeze({ classification: 'environment', confidence: 'high', reasons: ['observed environment or resource failure'] });
  }
  const firstPassAfterFailure = attempts.findIndex((attempt, index) => index > 0 && attempt?.ok === true);
  if (firstPassAfterFailure !== -1) {
    return deepFreeze({ classification: 'flake', confidence: 'high', reasons: ['a bounded retry passed after an initial failure'] });
  }
  if (scenario.classificationHints?.includes('scenario')) {
    return deepFreeze({ classification: 'scenario', confidence: 'medium', reasons: ['scenario-owned controlled failure hint matched the observation'] });
  }
  if (failed.length >= 2) {
    const semantics = failed.map(attempt => normalizeFailure({ message: attemptText(attempt) }));
    const same = semantics.every(value => value === semantics[0])
      && failed.every(attempt => attempt.failedCheck === failed[0].failedCheck && attempt.status === failed[0].status);
    if (same) return deepFreeze({ classification: 'product', confidence: 'high', reasons: ['repeatable failure matched across bounded attempts'] });
  }
  return deepFreeze({ classification: 'product', confidence: 'low', reasons: ['single assertion failure requires confirmation'] });
}

function prepareEvidenceStreamForRedaction(stream) {
  assertObject(stream, 'stream');
  const base = { ...stream };
  delete base.head;
  delete base.tail;
  const escapeLiteralMarkers = value => String(value).replace(
    /\n<(\d+) bytes omitted>\n/g,
    '\n<literal omission marker: $1 bytes>\n',
  );
  if (!stream.truncated) {
    return {
      stream: {
        ...base,
        preview: escapeLiteralMarkers(stream.preview),
      },
      boundaryRedactions: 0,
    };
  }
  if (typeof stream.head !== 'string' || typeof stream.tail !== 'string') {
    fail('stream', 'truncated stream requires structural head and tail provenance');
  }
  if (!Number.isInteger(stream.bytes) || stream.bytes < 0
    || !Number.isInteger(stream.omittedBytes) || stream.omittedBytes <= 0) {
    fail('stream', 'truncated stream requires valid byte provenance');
  }
  const retainedBytes = Buffer.byteLength(stream.head) + Buffer.byteLength(stream.tail);
  if (retainedBytes + stream.omittedBytes !== stream.bytes) {
    fail('stream', 'structural head and tail do not match byte provenance');
  }
  const lastHeadBreak = stream.head.lastIndexOf('\n');
  const firstTailBreak = stream.tail.indexOf('\n');
  const safeRawHead = lastHeadBreak === -1 ? '' : stream.head.slice(0, lastHeadBreak + 1);
  const safeRawTail = firstTailBreak === -1 ? '' : stream.tail.slice(firstTailBreak + 1);
  const boundarySuppressedBytes = retainedBytes
    - Buffer.byteLength(safeRawHead)
    - Buffer.byteLength(safeRawTail);
  const safeHead = escapeLiteralMarkers(safeRawHead);
  const safeTail = escapeLiteralMarkers(safeRawTail);
  const structuralMarker = `\n<${stream.omittedBytes + boundarySuppressedBytes} bytes omitted>\n`;
  return {
    stream: {
      ...base,
      boundarySuppressedBytes,
      preview: `${safeHead}<redacted-boundary>${structuralMarker}<redacted-boundary>${safeTail}`,
    },
    boundaryRedactions: 1,
  };
}

function sealEvidenceStream(stream, maxBytes) {
  positiveInteger(maxBytes, 'maxBytes');
  if (maxBytes < MIN_OUTPUT_BYTES) fail('maxBytes', `must be at least ${MIN_OUTPUT_BYTES}`);
  const boundarySuppressedBytes = Number.isInteger(stream.boundarySuppressedBytes)
    ? stream.boundarySuppressedBytes
    : 0;
  const structuralMarker = stream.truncated
    ? `\n<${stream.omittedBytes + boundarySuppressedBytes} bytes omitted>\n`
    : null;
  const markerStart = structuralMarker ? stream.preview.indexOf(structuralMarker) : -1;
  if (stream.truncated && markerStart === -1) fail('stream.preview', 'structural omission marker is missing');
  const marker = markerStart !== -1;
  const before = marker ? stream.preview.slice(0, markerStart) : stream.preview;
  const after = marker ? stream.preview.slice(markerStart + structuralMarker.length) : stream.preview;
  const observedOmittedBytes = stream.truncated ? stream.omittedBytes : 0;
  const finish = (preview, redactedOmittedBytes) => ({
    preview,
    previewBytes: Buffer.byteLength(preview),
    observedBytes: stream.bytes,
    observedOmittedBytes,
    redactedOmittedBytes,
    sha256: `sha256:${createHash('sha256').update(preview).digest('hex')}`,
    digestScope: 'redacted-preview',
    truncated: observedOmittedBytes + redactedOmittedBytes > 0,
  });
  if (Buffer.byteLength(stream.preview) <= maxBytes) {
    return finish(stream.preview, boundarySuppressedBytes);
  }
  const headBuffer = Buffer.from(before);
  const tailBuffer = Buffer.from(after);
  const totalVisibleBytes = marker ? headBuffer.length + tailBuffer.length : headBuffer.length;
  let redactedOmittedBytes = boundarySuppressedBytes;
  let totalOmittedBytes = observedOmittedBytes + redactedOmittedBytes;
  let omittedMarker = `\n<${totalOmittedBytes} bytes omitted>\n`;
  let available = Math.max(0, maxBytes - Buffer.byteLength(omittedMarker));
  let head = decodePrefix(headBuffer, Math.ceil(available / 2));
  let tail = decodeSuffix(tailBuffer, Math.floor(available / 2));
  redactedOmittedBytes = boundarySuppressedBytes + totalVisibleBytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
  totalOmittedBytes = observedOmittedBytes + redactedOmittedBytes;
  omittedMarker = `\n<${totalOmittedBytes} bytes omitted>\n`;
  available = Math.max(0, maxBytes - Buffer.byteLength(omittedMarker));
  head = decodePrefix(headBuffer, Math.ceil(available / 2));
  tail = decodeSuffix(tailBuffer, Math.floor(available / 2));
  redactedOmittedBytes = boundarySuppressedBytes + totalVisibleBytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
  totalOmittedBytes = observedOmittedBytes + redactedOmittedBytes;
  omittedMarker = `\n<${totalOmittedBytes} bytes omitted>\n`;
  while (Buffer.byteLength(head + omittedMarker + tail) > maxBytes && (tail || head)) {
    if (tail) tail = decodeSuffix(Buffer.from(tail), Buffer.byteLength(tail) - 1);
    else head = decodePrefix(Buffer.from(head), Buffer.byteLength(head) - 1);
    redactedOmittedBytes = boundarySuppressedBytes + totalVisibleBytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
    totalOmittedBytes = observedOmittedBytes + redactedOmittedBytes;
    omittedMarker = `\n<${totalOmittedBytes} bytes omitted>\n`;
  }
  const preview = head + omittedMarker + tail;
  return finish(preview, redactedOmittedBytes);
}

export function buildEvidenceBundle({ scenario, registryDigest, execution, redactionContext = {} }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(registryDigest || '')) fail('registryDigest', 'must be a SHA-256 digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(scenario?.runner?.sourceDigest || '')) {
    fail('scenario.runner.sourceDigest', 'must bind evidence to validated runner source');
  }
  if (!execution || !Array.isArray(execution.attempts) || execution.attempts.length === 0) fail('execution.attempts', 'must be non-empty');
  const scenarioSnapshot = structuredClone(scenario);
  if (containsSecretMaterial(scenarioSnapshot)) fail('scenario', 'must not contain credential-bearing material');
  const scenarioDigest = digestValue(scenarioSnapshot);
  const preparedAttempts = structuredClone(execution.attempts);
  let boundaryRedactions = 0;
  for (const attempt of preparedAttempts) {
    for (const streamName of ['stdout', 'stderr']) {
      const prepared = prepareEvidenceStreamForRedaction(attempt[streamName]);
      attempt[streamName] = prepared.stream;
      boundaryRedactions += prepared.boundaryRedactions;
    }
  }
  const redacted = redactEvidence({ attempts: preparedAttempts }, redactionContext);
  const sealedAttempts = structuredClone(redacted.value.attempts);
  for (const attempt of sealedAttempts) {
    for (const streamName of ['stdout', 'stderr']) {
      attempt[streamName] = sealEvidenceStream(attempt[streamName], scenario.risk.maxOutputBytes);
    }
  }
  const failedAttempt = sealedAttempts.find(attempt => !attempt.ok) || null;
  const fingerprint = failedAttempt
    ? buildFailureFingerprint(failureIdentity(scenarioSnapshot, scenarioDigest, failedAttempt))
    : digestValue({ schema: 'chrome-cdp-ex.validation-pass.v1', scenarioId: scenario.id, scenarioDigest });
  const classification = failedAttempt ? classifyFailure(sealedAttempts, scenario) : null;
  return deepFreeze({
    schema: 'chrome-cdp-ex.validation-evidence.v1',
    redacted: true,
    scenario: scenarioSnapshot,
    scenarioDigest,
    registryDigest,
    ok: execution.ok,
    attempts: sealedAttempts,
    classification: classification?.classification ?? null,
    classificationConfidence: classification?.confidence ?? 'not-applicable',
    classificationReasons: classification?.reasons ?? ['scenario passed'],
    fingerprint,
    replay: [...CANONICAL_REPLAY],
    duplicateOf: null,
    redactionCounts: {
      ...redacted.counts,
      credential: redacted.counts.credential + boundaryRedactions,
    },
  });
}

function validateEvidenceStream(stream, path, maxBytes) {
  assertObject(stream, path);
  assertOnlyKeys(stream, STREAM_KEYS, path);
  if (typeof stream.preview !== 'string') fail(`${path}.preview`, 'must be a string');
  for (const key of ['previewBytes', 'observedBytes', 'observedOmittedBytes', 'redactedOmittedBytes']) {
    if (!Number.isInteger(stream[key]) || stream[key] < 0) fail(`${path}.${key}`, 'must be a non-negative integer');
  }
  if (typeof stream.truncated !== 'boolean') fail(`${path}.truncated`, 'must be boolean');
  if (stream.digestScope !== 'redacted-preview') fail(`${path}.digestScope`, 'must equal redacted-preview');
  const expected = `sha256:${createHash('sha256').update(stream.preview).digest('hex')}`;
  if (stream.sha256 !== expected) fail(`${path}.sha256`, 'does not match the redacted preview');
  const actualPreviewBytes = Buffer.byteLength(stream.preview);
  if (stream.previewBytes !== actualPreviewBytes) fail(`${path}.previewBytes`, 'does not match preview');
  if (actualPreviewBytes > maxBytes) fail(`${path}.preview`, 'exceeds scenario byte cap');
  if (stream.observedOmittedBytes > stream.observedBytes) fail(`${path}.observedOmittedBytes`, 'exceeds observed bytes');
  if ((stream.observedOmittedBytes > 0) !== (stream.observedBytes > maxBytes)) {
    fail(path, 'observed truncation must exactly match the raw byte cap');
  }
  const totalOmittedBytes = stream.observedOmittedBytes + stream.redactedOmittedBytes;
  const markers = [...stream.preview.matchAll(/\n<(\d+) bytes omitted>\n/g)];
  if (stream.truncated !== (totalOmittedBytes > 0)) fail(path, 'truncation flag does not match omitted byte scopes');
  if (totalOmittedBytes === 0) {
    if (markers.length !== 0) fail(path, 'untruncated stream cannot contain an omission marker');
  } else {
    if (markers.length !== 1) fail(path, 'truncated stream requires one omitted marker');
    if (Number(markers[0][1]) !== totalOmittedBytes) fail(path, 'omitted marker does not match byte scopes');
  }
}

function validateEvidenceAttempt(attempt, path, maxBytes) {
  assertObject(attempt, path);
  assertOnlyKeys(attempt, ATTEMPT_KEYS, path);
  for (const key of ['ok', 'timedOut', 'outputOverflow']) {
    if (typeof attempt[key] !== 'boolean') fail(`${path}.${key}`, 'must be boolean');
  }
  if (attempt.status !== null && !Number.isInteger(attempt.status)) fail(`${path}.status`, 'must be an integer or null');
  for (const key of ['signal', 'spawnError', 'cleanupError', 'failedPhase', 'failedCheck']) {
    if (attempt[key] !== null && typeof attempt[key] !== 'string') fail(`${path}.${key}`, 'must be a string or null');
  }
  if (typeof attempt.failureMessage !== 'string') fail(`${path}.failureMessage`, 'must be a string');
  if (typeof attempt.durationMs !== 'number' || !Number.isFinite(attempt.durationMs) || attempt.durationMs < 0) {
    fail(`${path}.durationMs`, 'must be a non-negative finite number');
  }
  if (attempt.ok && (attempt.failedPhase !== null || attempt.failedCheck !== null)) fail(path, 'passing attempt must not carry failure identity');
  if (!attempt.ok && (typeof attempt.failedPhase !== 'string' || typeof attempt.failedCheck !== 'string')) fail(path, 'failed attempt requires failure identity');
  validateEvidenceStream(attempt.stdout, `${path}.stdout`, maxBytes);
  validateEvidenceStream(attempt.stderr, `${path}.stderr`, maxBytes);
}

export function verifyEvidenceBundle(bundle, { rootDir, registry } = {}) {
  assertObject(bundle, 'bundle');
  assertOnlyKeys(bundle, EVIDENCE_KEYS, 'bundle');
  if (bundle.schema !== 'chrome-cdp-ex.validation-evidence.v1') fail('bundle.schema', 'is invalid');
  if (bundle.redacted !== true) fail('bundle.redacted', 'must be true');
  if (!/^sha256:[a-f0-9]{64}$/.test(bundle.registryDigest || '')) fail('bundle.registryDigest', 'is invalid');
  if (!/^sha256:[a-f0-9]{64}$/.test(bundle.scenarioDigest || '')) fail('bundle.scenarioDigest', 'is invalid');
  if (digestValue(bundle.scenario) !== bundle.scenarioDigest) fail('bundle.scenarioDigest', 'does not match embedded scenario');
  if (!/^sha256:[a-f0-9]{64}$/.test(bundle.fingerprint || '')) fail('bundle.fingerprint', 'is invalid');
  const canonical = validateScenarioRegistry({ schema: REGISTRY_SCHEMA, scenarios: [bundle.scenario] }, { rootDir });
  if (registry) {
    if (digestValue(registry) !== bundle.registryDigest) fail('bundle.registryDigest', 'does not match supplied registry');
    const current = registry.scenarios.find(entry => entry.id === bundle.scenario.id);
    if (!current || digestValue(current) !== bundle.scenarioDigest) fail('bundle.scenarioDigest', 'does not match supplied registry scenario');
  }
  if (containsSecretMaterial(bundle)) fail('bundle', 'contains secret-bearing or machine-local material');
  if (typeof bundle.ok !== 'boolean') fail('bundle.ok', 'must be boolean');
  if (!Array.isArray(bundle.attempts) || bundle.attempts.length === 0) fail('bundle.attempts', 'must be a non-empty array');
  if (bundle.attempts.length > canonical.scenarios[0].risk.maxAttempts) fail('bundle.attempts', 'exceeds scenario attempt bound');
  bundle.attempts.forEach((attempt, index) => validateEvidenceAttempt(
    attempt,
    `bundle.attempts[${index}]`,
    canonical.scenarios[0].risk.maxOutputBytes,
  ));
  const firstPass = bundle.attempts.findIndex(attempt => attempt.ok === true);
  if (firstPass !== -1 && firstPass !== bundle.attempts.length - 1) {
    fail('bundle.attempts', 'attempt sequence cannot continue after the first pass');
  }
  if (bundle.ok !== (bundle.attempts.at(-1)?.ok === true)) fail('bundle.ok', 'does not match final attempt');
  if (bundle.duplicateOf !== null && (typeof bundle.duplicateOf !== 'string' || bundle.duplicateOf === '')) {
    fail('bundle.duplicateOf', 'must be a non-empty string or null');
  }
  if (canonicalJson(bundle.replay) !== canonicalJson(CANONICAL_REPLAY)) fail('bundle.replay', 'must equal canonical replay argv');
  assertObject(bundle.redactionCounts, 'bundle.redactionCounts');
  assertOnlyKeys(bundle.redactionCounts, REDACTION_COUNT_KEYS, 'bundle.redactionCounts');
  for (const key of REDACTION_COUNT_KEYS) {
    if (!Number.isInteger(bundle.redactionCounts[key]) || bundle.redactionCounts[key] < 0) {
      fail(`bundle.redactionCounts.${key}`, 'must be a non-negative integer');
    }
  }
  const scenario = canonical.scenarios[0];
  const failedAttempt = bundle.attempts.find(attempt => !attempt.ok) || null;
  const expectedFingerprint = failedAttempt
    ? buildFailureFingerprint(failureIdentity(scenario, bundle.scenarioDigest, failedAttempt))
    : digestValue({ schema: 'chrome-cdp-ex.validation-pass.v1', scenarioId: scenario.id, scenarioDigest: bundle.scenarioDigest });
  if (bundle.fingerprint !== expectedFingerprint) fail('bundle.fingerprint', 'does not match verified evidence');
  if (!failedAttempt) {
    if (bundle.classification !== null || bundle.classificationConfidence !== 'not-applicable') fail('bundle.classification', 'must describe a pass');
    if (canonicalJson(bundle.classificationReasons) !== canonicalJson(['scenario passed'])) fail('bundle.classificationReasons', 'must describe a pass');
  } else {
    const classification = classifyFailure(bundle.attempts, scenario);
    if (bundle.classification !== classification.classification
      || bundle.classificationConfidence !== classification.confidence
      || canonicalJson(bundle.classificationReasons) !== canonicalJson(classification.reasons)) {
      fail('bundle.classification', 'does not match recomputed classification');
    }
  }
  return scenario;
}

export async function replayEvidenceBundle(bundle, context = {}) {
  const scenario = verifyEvidenceBundle(bundle, { rootDir: context.rootDir, registry: context.registry });
  const live = scenario.risk.browser !== 'none' || scenario.risk.network !== 'none';
  if (live && context.allowLive !== true) fail(`scenario ${scenario.id}`, 'live replay requires allowLive');
  const execution = await executeScenario(scenario, context);
  return deepFreeze({
    execution,
    bundle: buildEvidenceBundle({
      scenario,
      registryDigest: bundle.registryDigest,
      execution,
      redactionContext: context.redactionContext || {},
    }),
  });
}

function containsSecretMaterial(value) {
  let found = false;
  const visit = (input, key = '') => {
    if (found) return;
    if (Array.isArray(input)) {
      input.forEach((item, index) => {
        if (typeof item === 'string' && CREDENTIAL_ARG_FLAG_RE.test(item)
          && typeof input[index + 1] === 'string' && input[index + 1] !== '<redacted>') {
          found = true;
          return;
        }
        visit(item);
      });
      return;
    }
    if (input && typeof input === 'object') {
      for (const [childKey, child] of Object.entries(input)) visit(child, childKey);
      return;
    }
    if (SENSITIVE_KEY_RE.test(key) && input !== '<redacted>') {
      found = true;
      return;
    }
    if (typeof input !== 'string') return;
    if (/\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+(?!<redacted>)[^\s,;]+/i.test(input)
      || /\b(?:bearer|basic)\s+(?!<redacted>)[A-Za-z0-9._~+/-]+/i.test(input)
      || /\b(?:set-cookie|cookie)\s*[:=]\s*(?!<redacted>)[^\r\n]+/i.test(input)
      || CREDENTIAL_UNTERMINATED_VALUE_DETECT_RE.test(input)
      || CREDENTIAL_HEADER_DETECT_RE.test(input)
      || CLI_CREDENTIAL_VALUE_DETECT_RE.test(input)
      || /[?&](?:access_token|api_key|auth|authorization|cookie|key|password|secret|session|token)=(?!<redacted>(?:[&#\s]|$))[^&#\s]+/i.test(input)
      || /\/Users\/[^\s'"<>]+/.test(input)
      || /\/home\/[^\s'"<>]+/.test(input)
      || /[A-Za-z]:\\Users\\[^\s'"<>]+/.test(input)
      || /\/(?:private\/)?tmp\/[^\s'"<>]+/.test(input)) {
      found = true;
    }
  };
  visit(value);
  return found;
}

export function buildRegressionSeed(bundle, { confirmed = false, rootDir, registry } = {}) {
  if (confirmed !== true) fail('confirmation', '--confirm-product-regression is required');
  const scenario = verifyEvidenceBundle(bundle, { rootDir, registry });
  if (bundle.ok !== false) fail('bundle', 'must be a failed product observation');
  if (bundle.duplicateOf) fail('bundle.duplicateOf', 'duplicate-only evidence cannot be promoted');
  if (containsSecretMaterial(bundle)) fail('bundle', 'secret-bearing evidence cannot be promoted');
  const failed = bundle.attempts.filter(attempt => attempt?.ok === false);
  if (failed.length < 2) fail('bundle.attempts', 'a repeatable failure requires at least two failed attempts');
  const classification = classifyFailure(bundle.attempts, scenario);
  if (classification.classification !== 'product' || classification.confidence !== 'high') {
    fail('bundle.classification', `must be repeatable product, received ${classification.classification}/${classification.confidence}`);
  }
  if (bundle.classification !== classification.classification || bundle.classificationConfidence !== classification.confidence) {
    fail('bundle.classification', 'does not match recomputed classification');
  }
  const fingerprints = failed.map(attempt => buildFailureFingerprint(failureIdentity(scenario, bundle.scenarioDigest, attempt)));
  if (fingerprints.some(fingerprint => fingerprint !== bundle.fingerprint)) {
    fail('bundle.fingerprint', 'does not match every repeatable failed attempt');
  }
  const identity = failureIdentity(scenario, bundle.scenarioDigest, failed[0]);
  return deepFreeze({
    schema: 'chrome-cdp-ex.validation-regression.v1',
    scenario,
    scenarioDigest: bundle.scenarioDigest,
    fingerprint: bundle.fingerprint,
    failedPhase: identity.failedPhase,
    failedCheck: identity.failedCheck,
    normalizedFailure: identity.normalizedFailure,
    classification: 'product',
    classificationConfidence: 'high',
    classificationReasons: classification.reasons,
    replay: [...bundle.replay],
    sourceBundleDigest: digestValue(bundle),
  });
}

export function writeRegressionSeed(outPath, seed, { allowedRoot } = {}) {
  if (typeof outPath !== 'string' || !isAbsolute(outPath)) fail('outPath', 'must be absolute');
  if (typeof allowedRoot !== 'string' || !isAbsolute(allowedRoot)) fail('allowedRoot', 'must be absolute');
  const target = resolve(outPath);
  if (isOutside(resolve(allowedRoot), target)) fail('outPath', 'must not escape allowed root');
  const parent = dirname(target);
  assertResolvedContained(allowedRoot, parent, 'outPath', 'directory');
  const content = `${JSON.stringify(seed, null, 2)}\n`;
  const temp = resolve(parent, `.${target.split(sep).at(-1)}.${process.pid}.${Date.now()}.partial`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temp, target);
    unlinkSync(temp);
    return target;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

function evidenceFilename(bundle) {
  if (!ID_RE.test(bundle?.scenario?.id || '')) fail('bundle.scenario.id', 'is invalid');
  if (!/^sha256:[a-f0-9]{64}$/.test(bundle?.fingerprint || '')) fail('bundle.fingerprint', 'is invalid');
  return `${bundle.scenario.id}-${bundle.fingerprint.slice(7, 23)}.json`;
}

export function findDuplicateEvidence(outDir, bundle, { rootDir, registry } = {}) {
  if (!existsSync(outDir)) return null;
  if (!rootDir) return null;
  for (const name of readdirSync(outDir).filter(entry => entry.endsWith('.json')).sort()) {
    const path = resolve(outDir, name);
    let candidate;
    try {
      candidate = JSON.parse(readFileSync(path, 'utf8'));
      verifyEvidenceBundle(candidate, { rootDir, registry });
    } catch {
      continue;
    }
    if (candidate.schema !== 'chrome-cdp-ex.validation-evidence.v1') continue;
    if (candidate.scenario?.id !== bundle.scenario?.id) continue;
    if (candidate.scenarioDigest !== bundle.scenarioDigest) continue;
    if (candidate.fingerprint !== bundle.fingerprint) continue;
    if (candidate.ok !== bundle.ok) continue;
    const duplicateOf = rootDir && !relative(rootDir, path).startsWith('..')
      ? relative(rootDir, path).split(sep).join('/')
      : name;
    return deepFreeze({ path, duplicateOf });
  }
  return null;
}

export function writeEvidenceBundle(outDir, bundle, options = {}) {
  if (typeof outDir !== 'string' || !isAbsolute(outDir)) fail('outDir', 'must be absolute');
  if (typeof options.rootDir !== 'string' || !isAbsolute(options.rootDir)) fail('rootDir', 'verification context is required before evidence write');
  verifyEvidenceBundle(bundle, { rootDir: options.rootDir, registry: options.registry });
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const name = evidenceFilename(bundle);
  const target = resolve(outDir, name);
  if (relative(outDir, target).startsWith('..')) fail('outDir', 'resolved evidence escapes output directory');
  const content = `${JSON.stringify(bundle, null, 2)}\n`;
  const duplicate = findDuplicateEvidence(outDir, bundle, options);
  if (duplicate) return deepFreeze({ ...duplicate, duplicate: true });
  if (existsSync(target)) {
    if (readFileSync(target, 'utf8') === content) return deepFreeze({ path: target, duplicate: true });
    fail('bundle', `refusing to overwrite a different bundle at ${name}`);
  }
  const temp = resolve(outDir, `.${name}.${process.pid}.${Date.now()}.partial`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temp, target);
    unlinkSync(temp);
    return deepFreeze({ path: target, duplicate: false });
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}
