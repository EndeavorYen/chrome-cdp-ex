#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

import {
  REQUIRED_RELEASE_ENTRIES,
  listTarEntries,
  validatePackageInventory,
} from './check-release-package.mjs';
import {
  MCP_PROTOCOL_VERSION,
  MCP_RESOURCE_TEMPLATES,
  MCP_RUN_COMMAND_ALLOWLIST,
  MCP_RUN_COMMAND_MUTATING,
  MCP_SERVER_VERSION,
  MCP_TOOL_DEFINITIONS,
  argsRequireConfirm,
  buildMcpResourceCommand,
  buildMcpToolCommand,
  listMcpResources,
} from '../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs';
import { COMMAND_SURFACE } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_NAME = 'public-contracts.v1.json';

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

const UNORDERED_ARRAY_KEYS = new Set(['required', 'enum', 'type']);

export function canonicalizeContract(value, path = []) {
  if (Array.isArray(value)) {
    const items = value.map(item => canonicalizeContract(item, [...path, '*']));
    const key = path.at(-1) || '';
    const schemaScoped = path.includes('document') || path.includes('inputSchema');
    return schemaScoped && UNORDERED_ARRAY_KEYS.has(key)
      ? items.sort((left, right) => {
        const leftJson = JSON.stringify(left);
        const rightJson = JSON.stringify(right);
        return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
      })
      : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(childKey => [childKey, canonicalizeContract(value[childKey], [...path, childKey])]),
    );
  }
  return value;
}

function printable(value, maxLength = 240) {
  if (value === undefined) return '<missing>';
  const rendered = JSON.stringify(value);
  if (rendered.length <= maxLength) return rendered;
  return `${rendered.slice(0, maxLength)}…<${rendered.length - maxLength} chars omitted>`;
}

export function diffContracts(expected, actual, { limit = 50 } = {}) {
  const differences = [];
  const visit = (left, right, path) => {
    if (differences.length >= limit) return;
    if (Object.is(left, right)) return;
    const leftArray = Array.isArray(left);
    const rightArray = Array.isArray(right);
    if (leftArray || rightArray) {
      if (!leftArray || !rightArray) {
        differences.push(`${path}: expected ${printable(left)}, received ${printable(right)}`);
        return;
      }
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index += 1) {
        visit(left[index], right[index], `${path}[${index}]`);
      }
      return;
    }
    const leftObject = left && typeof left === 'object';
    const rightObject = right && typeof right === 'object';
    if (leftObject || rightObject) {
      if (!leftObject || !rightObject) {
        differences.push(`${path}: expected ${printable(left)}, received ${printable(right)}`);
        return;
      }
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys) visit(left[key], right[key], path ? `${path}.${key}` : key);
      return;
    }
    differences.push(`${path}: expected ${printable(left)}, received ${printable(right)}`);
  };
  visit(expected, actual, '');
  return differences;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function schemaProjection(rootDir) {
  const schemaDir = join(rootDir, 'docs', 'schemas');
  const files = readdirSync(schemaDir).filter(name => name.endsWith('.json')).sort();
  const seenIds = new Set();
  return files.map(name => {
    const path = join(schemaDir, name);
    const document = readJson(path);
    if (!document || Array.isArray(document) || typeof document !== 'object') {
      throw new Error(`Public schema must be a JSON object: ${name}`);
    }
    const id = document.$id;
    if (typeof id !== 'string' || !id.trim()) throw new Error(`Public schema is missing $id: ${name}`);
    if (seenIds.has(id)) throw new Error(`Duplicate public schema $id: ${id}`);
    seenIds.add(id);
    return {
      document: canonicalize(document),
      id,
      path: relative(rootDir, path).split(sep).join('/'),
    };
  });
}

async function commandProjection() {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const module = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
    if (!module.__test__?.COMMANDS) throw new Error('cdp.mjs did not expose __test__.COMMANDS');
    return module.__test__.COMMANDS.map(command => {
      const policy = COMMAND_SURFACE.resolve(command.name);
      if (!policy) throw new Error(`command-surface policy missing for ${command.name}`);
      return {
        aliases: [...(command.aliases || [])],
        authorization: policy.authorization,
        evidencePolicy: policy.evidencePolicy,
        feedbackPolicy: command.feedbackPolicy || null,
        kind: policy.kind,
        mutates: command.mutates === true,
        name: command.name,
        needsTarget: command.needsTarget === true,
        outputFormats: [...(command.outputFormats || [])],
      };
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

const CLI_CASES = Object.freeze([
  { id: 'no-args-help', argv: [] },
  { id: 'help', argv: ['help'] },
  { id: 'unknown-command-suggestion', argv: ['perceev'] },
  { id: 'invalid-list-argument', argv: ['list', '--bogus'] },
  { id: 'invalid-format', argv: ['list', '--format', 'yaml'] },
  { id: 'missing-target', argv: ['perceive'] },
]);

function normalizeOutput(value) {
  return String(value || '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimEnd();
}

function cliProjection(rootDir) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-contract-cli-'));
  const runtimeDir = join(fixtureRoot, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  try {
    const script = join(rootDir, 'skills', 'chrome-cdp-ex', 'scripts', 'cdp.mjs');
    const env = {
      FORCE_COLOR: '0',
      HOME: fixtureRoot,
      NO_COLOR: '1',
      PATH: process.env.PATH || '',
      TMPDIR: fixtureRoot,
      XDG_RUNTIME_DIR: runtimeDir,
    };
    return CLI_CASES.map(({ id, argv }) => {
      const result = spawnSync(process.execPath, [script, ...argv], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env,
        shell: false,
        timeout: 5_000,
      });
      if (result.error) throw new Error(`CLI contract case ${id} failed to run: ${result.error.message}`);
      if (!Number.isInteger(result.status)) throw new Error(`CLI contract case ${id} did not return an exit code`);
      const entry = {
        argv: [...argv],
        exitCode: result.status,
        id,
        stderr: normalizeOutput(result.stderr),
        stdout: normalizeOutput(result.stdout),
      };
      const serialized = JSON.stringify(entry);
      if (serialized.includes(rootDir) || serialized.includes(fixtureRoot) || /\/(?:Users|home)\/[^/\s"']+/.test(serialized) || /[A-Za-z]:\\Users\\[^\\\s"']+/.test(serialized)) {
        throw new Error(`CLI contract case ${id} contains a machine-local path`);
      }
      return entry;
    });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

const MCP_MAPPING_INPUTS = Object.freeze([
  { id: 'doctor', tool: 'doctor', args: {} },
  { id: 'list-tabs', tool: 'list_tabs', args: {} },
  { id: 'open-attach-alias', tool: 'open_or_attach', args: { target: 'fixture-target', name: 'fixture' } },
  { id: 'open-new-tab', tool: 'open_or_attach', args: { url: 'https://example.test/', confirm: true } },
  { id: 'select-target', tool: 'select_target', args: { url: 'example.test', exact: true } },
  { id: 'perceive', tool: 'perceive', args: { target: 'fixture', depth: 4, cursorInteractive: true } },
  { id: 'controls', tool: 'controls', args: { target: 'fixture', limit: 10 } },
  { id: 'overlay', tool: 'overlay', args: { target: 'fixture', selector: '@1' } },
  { id: 'screenshot', tool: 'screenshot', args: { target: 'fixture', annotate: true } },
  { id: 'click', tool: 'click', args: { target: 'fixture', selector: '@1', confirm: true } },
  { id: 'verify-click', tool: 'verify_click', args: { target: 'fixture', selector: '@1', expectText: 'Done', confirm: true } },
  { id: 'dismiss-modal', tool: 'dismiss_modal', args: { target: 'fixture', confirm: true } },
  { id: 'fill', tool: 'fill', args: { target: 'fixture', selector: '#name', text: 'Ada', confirm: true } },
  { id: 'viewport-read', tool: 'viewport', args: { target: 'fixture' } },
  { id: 'viewport-set', tool: 'viewport', args: { target: 'fixture', size: '1280x720', confirm: true } },
  { id: 'qa-page', tool: 'qa_page', args: { target: 'fixture', desktop: '1280x720', confirm: true } },
  { id: 'responsive-audit', tool: 'responsive_audit', args: { target: 'fixture', viewports: ['390x844', '1280x720'], confirm: true } },
  { id: 'report', tool: 'report', args: { target: 'fixture', last: 3 } },
  { id: 'navigate', tool: 'navigate', args: { target: 'fixture', url: 'https://example.test/next', confirm: true } },
  { id: 'press', tool: 'press', args: { target: 'fixture', key: 'Enter', confirm: true } },
  { id: 'wait-for-text', tool: 'wait_for', args: { target: 'fixture', text: 'Ready', timeoutMs: 500 } },
  { id: 'wait-for-any', tool: 'wait_for', args: { target: 'fixture', anyOf: 'Ready|Done', scope: '#app', timeoutMs: 500 } },
  { id: 'wait-for-stable', tool: 'wait_for', args: { target: 'fixture', selectorStable: '#app', stableMs: 250, timeoutMs: 500 } },
  { id: 'cascade', tool: 'cascade', args: { target: 'fixture', selector: '@1', property: 'color' } },
  { id: 'components', tool: 'components', args: { target: 'fixture', selector: '#app', confirm: true } },
  { id: 'spawn-debug-browser', tool: 'spawn_debug_browser', args: { browser: 'edge', port: 9222, headless: true, confirm: true } },
  { id: 'record-snapshot', tool: 'record_snapshot', args: { target: 'fixture', durationMs: 250 } },
  { id: 'session-checkpoint', tool: 'session_checkpoint', args: { target: 'fixture', confirm: true } },
  { id: 'session-checkpoint-unsafe', tool: 'session_checkpoint', args: { target: 'fixture', unsafeFull: true, confirm: true } },
  { id: 'table-observe', tool: 'table', args: { target: 'fixture', selector: '#grid' } },
  { id: 'table-collect', tool: 'table', args: { target: 'fixture', selector: '#grid', collect: true, scrollContainer: '.viewport', confirm: true } },
  { id: 'table-continue', tool: 'table', args: { target: 'fixture', continue: 'ct1.0123456789abcdef0123456789abcdef.0' } },
  { id: 'run-command-read', tool: 'run_command', args: { command: 'help', args: [] } },
  { id: 'run-command-mutation', tool: 'run_command', args: { command: 'click', args: ['fixture', '@1'], confirm: true } },
  { id: 'run-command-table-observe', tool: 'run_command', args: { command: 'table', args: ['fixture', '#grid'] } },
  { id: 'run-command-table-collect', tool: 'run_command', args: { command: 'table', args: ['fixture', '#grid', '--collect', '--scroll-container', '.viewport'], confirm: true } },
  { id: 'run-command-table-continue', tool: 'run_command', args: { command: 'table', args: ['fixture', '--continue', 'ct1.0123456789abcdef0123456789abcdef.0', '--format', 'json'] } },
]);

const MCP_INVALID_INPUTS = Object.freeze([
  { id: 'mutation-without-confirm', kind: 'tool', tool: 'click', args: { target: 'fixture', selector: '@1' } },
  { id: 'sensitive-read-without-confirm', kind: 'tool', tool: 'components', args: { target: 'fixture', selector: '#app' } },
  { id: 'checkpoint-without-confirm', kind: 'tool', tool: 'session_checkpoint', args: { target: 'fixture' } },
  { id: 'qa-page-without-confirm', kind: 'tool', tool: 'qa_page', args: { target: 'fixture' } },
  { id: 'responsive-audit-without-confirm', kind: 'tool', tool: 'responsive_audit', args: { target: 'fixture' } },
  { id: 'missing-required-argument', kind: 'tool', tool: 'perceive', args: {} },
  { id: 'run-command-use-without-confirm', kind: 'tool', tool: 'run_command', args: { command: 'use', args: ['fixture', '--name', 'saved'] } },
  { id: 'run-command-forget-without-confirm', kind: 'tool', tool: 'run_command', args: { command: 'forget', args: ['saved'] } },
  { id: 'run-command-tab-group-mutation-without-confirm', kind: 'tool', tool: 'run_command', args: { command: 'tab-group', args: ['create', 'saved'] } },
  { id: 'run-command-loadall-without-confirm', kind: 'tool', tool: 'run_command', args: { command: 'loadall', args: ['fixture', '.more'] } },
  { id: 'run-command-record-action-without-confirm', kind: 'tool', tool: 'run_command', args: { command: 'record', args: ['fixture', '--action', 'click', '@1'] } },
  { id: 'run-command-keepalive-without-confirm', kind: 'tool', tool: 'run_command', args: { command: 'keepalive', args: ['fixture', '60000'] } },
  { id: 'run-command-console-clear-without-confirm', kind: 'tool', tool: 'run_command', args: { command: 'console', args: ['fixture', '--clear'] } },
  { id: 'run-command-netlog-clear-without-confirm', kind: 'tool', tool: 'run_command', args: { command: 'netlog', args: ['fixture', '--clear'] } },
  { id: 'run-command-diff-shot-reset-without-confirm', kind: 'tool', tool: 'run_command', args: { command: 'diff-shot', args: ['fixture', '--reset'] } },
  { id: 'run-command-shot-path-without-confirm', kind: 'tool', tool: 'run_command', args: { command: 'shot', args: ['fixture', '/tmp/explicit.png'] } },
  { id: 'run-command-fullshot-path-without-confirm', kind: 'tool', tool: 'run_command', args: { command: 'fullshot', args: ['fixture', '/tmp/explicit-full.png'] } },
  { id: 'run-command-table-collect-without-confirm', kind: 'tool', tool: 'run_command', args: { command: 'table', args: ['fixture', '#grid', '--collect', '--scroll-container', '.viewport'] } },
  { id: 'run-command-table-malformed', kind: 'tool', tool: 'run_command', args: { command: 'table', args: ['fixture', '#one', '#two'], confirm: true } },
  { id: 'table-collect-without-confirm', kind: 'tool', tool: 'table', args: { target: 'fixture', selector: '#grid', collect: true, scrollContainer: '.viewport' } },
  { id: 'table-selector-and-continue', kind: 'tool', tool: 'table', args: { target: 'fixture', selector: '#grid', continue: 'ct1.0123456789abcdef0123456789abcdef.0' } },
  { id: 'screenshot-path-without-confirm', kind: 'tool', tool: 'screenshot', args: { target: 'fixture', path: '/tmp/explicit.png' } },
  { id: 'run-command-not-allowlisted', kind: 'tool', tool: 'run_command', args: { command: 'rm', args: ['fixture'] } },
  { id: 'run-command-newline', kind: 'tool', tool: 'run_command', args: { command: 'help', args: ['bad\narg'] } },
  { id: 'unknown-tool', kind: 'tool', tool: 'not_a_tool', args: {} },
  { id: 'unknown-resource', kind: 'resource', uri: 'chrome-cdp-ex://unknown' },
]);

function mcpProjection(commands) {
  const toolNames = new Set(MCP_TOOL_DEFINITIONS.map(tool => tool.name));
  const commandSpellings = new Set(commands.flatMap(command => [command.name, ...command.aliases]));
  const mappingCases = MCP_MAPPING_INPUTS.map(entry => {
    const command = buildMcpToolCommand(entry.tool, entry.args);
    if (!commandSpellings.has(command[0])) {
      throw new Error(`MCP mapping ${entry.id} produced unknown CLI command: ${command[0]}`);
    }
    if (entry.tool === 'run_command') {
      const requiresConfirm = argsRequireConfirm(entry.args.command, entry.args.args);
      if (requiresConfirm && entry.args.confirm !== true) {
        throw new Error(`MCP mapping ${entry.id} omits required confirmation`);
      }
    }
    return { ...entry, command };
  });
  const covered = new Set(mappingCases.map(entry => entry.tool));
  const missing = [...toolNames].filter(name => !covered.has(name));
  if (missing.length) throw new Error(`MCP mapping inventory is missing tools: ${missing.join(', ')}`);
  const ids = mappingCases.map(entry => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error('MCP mapping inventory has duplicate case IDs');

  const invalidCases = MCP_INVALID_INPUTS.map(entry => {
    try {
      if (entry.kind === 'resource') buildMcpResourceCommand(entry.uri);
      else buildMcpToolCommand(entry.tool, entry.args);
    } catch (error) {
      return { ...entry, error: error.message || String(error) };
    }
    throw new Error(`Invalid MCP case unexpectedly succeeded: ${entry.id}`);
  });
  const resourceUris = [
    'chrome-cdp-ex://doctor/status',
    'chrome-cdp-ex://session/fixture/report',
    'chrome-cdp-ex://session/fixture/screenshot/latest',
  ];
  const resourceMappings = resourceUris.map(uri => ({
    command: buildMcpResourceCommand(uri),
    uri,
  }));
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverVersion: MCP_SERVER_VERSION,
    tools: MCP_TOOL_DEFINITIONS,
    runCommandAllowlist: [...MCP_RUN_COMMAND_ALLOWLIST].sort(),
    runCommandMutating: [...MCP_RUN_COMMAND_MUTATING].sort(),
    resourceTemplates: MCP_RESOURCE_TEMPLATES,
    resources: listMcpResources(),
    mappingCases,
    invalidCases,
    resourceMappings,
  };
}

export async function buildPublicContract({ rootDir = DEFAULT_ROOT } = {}) {
  const packageJson = readJson(join(rootDir, 'package.json'));
  const commands = await commandProjection();
  return canonicalizeContract({
    schema: 'chrome-cdp-ex.public-contracts.v1',
    productVersion: packageJson.version,
    commands,
    schemas: schemaProjection(rootDir),
    mcp: mcpProjection(commands),
    cliCases: cliProjection(rootDir),
    package: {
      name: packageJson.name,
      version: packageJson.version,
      bin: packageJson.bin || {},
      engines: packageJson.engines || null,
      files: packageJson.files || [],
      requiredReleaseEntries: [...REQUIRED_RELEASE_ENTRIES].sort(),
    },
  });
}

function parseArgs(args) {
  const options = { version: null, write: false, tarball: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--write') options.write = true;
    else if (arg === '--version') options.version = args[++index] || null;
    else if (arg === '--tarball') options.tarball = args[++index] || null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.version || !/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error('--version X.Y.Z is required');
  }
  return options;
}

function fixturePath(rootDir, version) {
  return join(rootDir, 'docs', 'contracts', `v${version}`, FIXTURE_NAME);
}

function packageFixturePath(rootDir, version) {
  return join(rootDir, 'docs', 'contracts', `v${version}`, 'package-entries.v1.json');
}

function packageInventory(version, entries) {
  return canonicalize({
    schema: 'chrome-cdp-ex.package-entries.v1',
    productVersion: version,
    entries: [...new Set(entries.filter(entry => !entry.endsWith('/')))].sort(),
  });
}

function writePackageInventory(rootDir, version, providedTarball = null) {
  const path = packageFixturePath(rootDir, version);
  mkdirSync(dirname(path), { recursive: true });
  try {
    readJson(path);
  } catch {
    writeFileSync(path, `${JSON.stringify(packageInventory(version, []), null, 2)}\n`);
  }

  let tarballPath = providedTarball ? resolve(providedTarball) : null;
  let temporaryRoot = null;
  try {
    if (!tarballPath) {
      temporaryRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-contract-pack-'));
      const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', temporaryRoot], {
        cwd: rootDir,
        encoding: 'utf8',
        shell: false,
      });
      if (packed.status !== 0) throw new Error(packed.stderr.trim() || 'npm pack failed');
      const result = JSON.parse(packed.stdout)[0];
      tarballPath = join(temporaryRoot, result.filename);
    }
    const listed = listTarEntries(tarballPath);
    if (listed.error) throw new Error(`Unable to list contract package: ${listed.error}`);
    writeFileSync(path, `${JSON.stringify(packageInventory(version, listed.entries), null, 2)}\n`);
    return path;
  } finally {
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function checkPackageInventory(rootDir, version, tarball = null) {
  const path = packageFixturePath(rootDir, version);
  let fixture;
  try {
    fixture = readJson(path);
  } catch (error) {
    throw new Error(`Unable to read package inventory fixture ${path}: ${error.message}`);
  }
  const structuralErrors = validatePackageInventory(fixture.entries || [], fixture, version);
  if (structuralErrors.length) throw new Error(structuralErrors.join('\n'));
  if (tarball) {
    const listed = listTarEntries(resolve(tarball));
    if (listed.error) throw new Error(`Unable to list contract package: ${listed.error}`);
    const errors = validatePackageInventory(listed.entries, fixture, version);
    if (errors.length) throw new Error(errors.join('\n'));
  }
  return path;
}

export async function runContractCheck({ rootDir = DEFAULT_ROOT, version, write = false, tarball = null }) {
  const actual = await buildPublicContract({ rootDir });
  if (version !== actual.productVersion) {
    throw new Error(`--version ${version} must match package version ${actual.productVersion}`);
  }
  const path = fixturePath(rootDir, version);
  const output = `${JSON.stringify(actual, null, 2)}\n`;
  if (write) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, output);
    writePackageInventory(rootDir, version, tarball);
    return { mode: 'write', path };
  }
  let expected;
  try {
    expected = readJson(path);
  } catch (error) {
    throw new Error(`Unable to read public contract fixture ${path}: ${error.message}`);
  }
  const differences = diffContracts(expected, actual);
  if (differences.length) {
    throw new Error(`Public contract drift detected:\n${differences.map(line => `- ${line}`).join('\n')}`);
  }
  checkPackageInventory(rootDir, version, tarball);
  return { mode: 'check', path };
}

async function main(args) {
  try {
    const options = parseArgs(args);
    const result = await runContractCheck({ ...options });
    console.log(`Public contracts ${result.mode === 'write' ? 'written' : 'OK'}: ${result.path}`);
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main(process.argv.slice(2));
