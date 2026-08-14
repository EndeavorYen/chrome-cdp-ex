#!/usr/bin/env node
/**
 * Cross-host bootstrap for chrome-cdp-ex.
 * Detects install paths, prints host config snippets, optionally writes Cursor MCP config,
 * and can verify doctor + MCP initialize.
 */
import { spawn } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SKILL_DIR = resolve(REPO_ROOT, 'skills', 'chrome-cdp-ex');
const CDP_SCRIPT = resolve(SKILL_DIR, 'scripts', 'cdp.mjs');
const MCP_SERVER = resolve(SKILL_DIR, 'scripts', 'mcp-server.mjs');

export const SUPPORTED_HOSTS = Object.freeze([
  'claude',
  'codex',
  'cursor',
  'openclaw',
  'hermes',
  'pi',
]);

export function hermesSkillPath({ home = homedir(), env = process.env } = {}) {
  const hermesHome = env.HERMES_HOME || join(home, '.hermes');
  return join(hermesHome, 'skills', 'chrome-cdp-ex');
}

export function detectEnvironment({
  home = homedir(),
  repoRoot = REPO_ROOT,
  env = process.env,
  fs: io = { existsSync },
} = {}) {
  const skillDir = resolve(repoRoot, 'skills', 'chrome-cdp-ex');
  const cdpScript = resolve(skillDir, 'scripts', 'cdp.mjs');
  const mcpServer = resolve(skillDir, 'scripts', 'mcp-server.mjs');
  const exists = io.existsSync || existsSync;
  const hosts = {
    claudeSkill: join(home, '.claude', 'skills', 'chrome-cdp-ex'),
    codexSkill: join(home, '.codex', 'skills', 'chrome-cdp-ex'),
    hermesSkill: hermesSkillPath({ home, env }),
    cursorMcp: join(repoRoot, '.cursor', 'mcp.json'),
    cursorUserMcp: join(home, '.cursor', 'mcp.json'),
  };
  return {
    schema: 'chrome-cdp-ex.setup-detect.v1',
    repoRoot: resolve(repoRoot),
    skillDir,
    cdpScript,
    mcpServer,
    binWrapper: resolve(repoRoot, 'bin', 'chrome-cdp'),
    node: process.execPath,
    nodeVersion: process.version,
    cdpPort: env.CDP_PORT || null,
    hosts: {
      claude: {
        skillPath: hosts.claudeSkill,
        installed: exists(hosts.claudeSkill),
        route: 'cli',
      },
      codex: {
        skillPath: hosts.codexSkill,
        installed: exists(hosts.codexSkill),
        route: 'cli',
      },
      cursor: {
        projectMcpPath: hosts.cursorMcp,
        userMcpPath: hosts.cursorUserMcp,
        projectConfigured: exists(hosts.cursorMcp),
        userConfigured: exists(hosts.cursorUserMcp),
        route: 'mcp',
      },
      openclaw: { route: 'mcp', notes: 'Register skill dir + stdio MCP server' },
      hermes: {
        skillPath: hosts.hermesSkill,
        installed: exists(hosts.hermesSkill),
        route: 'cli',
        notes: 'Prefer shell calls to cdp.mjs',
      },
      pi: { route: 'cli', notes: 'package.json pi.skills metadata' },
    },
    filesPresent: {
      skillMd: existsSync(join(skillDir, 'SKILL.md')),
      mcpServer: existsSync(mcpServer),
      pluginManifest: existsSync(join(repoRoot, '.claude-plugin', 'plugin.json')),
      integrations: existsSync(join(repoRoot, 'INTEGRATIONS.md')),
    },
  };
}

export function cursorMcpConfig({ mcpServer = MCP_SERVER, node = process.execPath, cdpPort } = {}) {
  const env = {};
  if (cdpPort) env.CDP_PORT = String(cdpPort);
  return {
    mcpServers: {
      'chrome-cdp-ex': {
        command: node,
        args: [mcpServer],
        ...(Object.keys(env).length ? { env } : {}),
      },
    },
  };
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function hostSnippet(host, detect = detectEnvironment()) {
  const cdp = shQuote(detect.cdpScript);
  const mcp = detect.mcpServer;
  const node = shQuote(detect.node);
  const skillDir = shQuote(detect.skillDir);
  const repoRoot = shQuote(detect.repoRoot);
  switch (host) {
    case 'claude':
      return [
        `# Claude Code`,
        `claude --plugin-dir ${repoRoot}`,
        `# or global skill:`,
        `mkdir -p ~/.claude/skills && cp -R ${skillDir} ~/.claude/skills/`,
        `# then:`,
        `${node} ${cdp} doctor`,
      ].join('\n');
    case 'codex':
      return [
        `# Codex`,
        `mkdir -p ~/.codex/skills && cp -R ${skillDir} ~/.codex/skills/`,
        `${node} ${cdp} doctor`,
      ].join('\n');
    case 'cursor':
      return JSON.stringify(cursorMcpConfig({
        mcpServer: mcp,
        node: detect.node,
        cdpPort: detect.cdpPort,
      }), null, 2);
    case 'openclaw':
      return [
        `# OpenClaw — skill copy + MCP registration`,
        `cp -R ${skillDir} <openclaw-skills-dir>/chrome-cdp-ex`,
        `# MCP stdio:`,
        JSON.stringify(cursorMcpConfig({ mcpServer: mcp, node: detect.node, cdpPort: detect.cdpPort }), null, 2),
      ].join('\n');
    case 'hermes': {
      const hermesDest = detect.hosts?.hermes?.skillPath || hermesSkillPath();
      const hermesParent = dirname(hermesDest);
      return [
        `# Hermes — prefer CLI`,
        `mkdir -p ${shQuote(hermesParent)} && cp -R ${skillDir} ${shQuote(`${hermesParent}/`)}`,
        `${node} ${cdp} doctor`,
        `${node} ${cdp} list`,
      ].join('\n');
    }
    case 'pi':
      return [
        `# Pi / pi-coding-agent`,
        `# package.json already declares pi.skills -> ./skills`,
        `# From this package root:`,
        `${node} ${cdp} doctor`,
      ].join('\n');
    default:
      throw new Error(`Unsupported host: ${host}. Use one of: ${SUPPORTED_HOSTS.join(', ')}`);
  }
}

export function routeRecommendation() {
  return {
    schema: 'chrome-cdp-ex.route-recommendation.v1',
    claude: 'cli',
    cursor: 'mcp',
    'claude-code-skill': 'cli',
    'claude-desktop-mcp': 'mcp',
    codex: 'cli',
    hermes: 'cli',
    'hermes-shell': 'cli',
    openclaw: 'mcp',
    pi: 'cli',
    notes: 'Matched live campaigns historically favor CLI for token cost; MCP is the portable host socket.',
  };
}

function mergeMcpConfig(existing, next) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const servers = {
    ...(base.mcpServers && typeof base.mcpServers === 'object' ? base.mcpServers : {}),
    ...next.mcpServers,
  };
  return { ...base, mcpServers: servers };
}

export function writeHostSkill({
  dest,
  skillDir = SKILL_DIR,
  dryRun = false,
  fs: io = { mkdirSync, cpSync },
} = {}) {
  if (!dest) throw new Error('writeHostSkill requires dest');
  if (!dryRun) {
    io.mkdirSync(dirname(dest), { recursive: true });
    io.cpSync(skillDir, dest, { recursive: true, force: true });
  }
  return { dest, dryRun, copied: !dryRun };
}

export function writeCursorMcpConfig({
  path,
  mcpServer = MCP_SERVER,
  node = process.execPath,
  cdpPort,
  dryRun = false,
} = {}) {
  if (!path) throw new Error('writeCursorMcpConfig requires path');
  const next = cursorMcpConfig({ mcpServer, node, cdpPort });
  let existing = null;
  if (existsSync(path)) {
    existing = JSON.parse(readFileSync(path, 'utf8'));
  }
  const merged = mergeMcpConfig(existing, next);
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  }
  return { path, dryRun, config: merged };
}

function runNodeScript(scriptPath, args = [], { timeoutMs = 15000 } = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function encodeMcpMessage(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

export function verifyMcpInitialize({ mcpServer = MCP_SERVER, timeoutMs = 5000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [mcpServer], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`MCP initialize timeout: ${stderr}`));
    }, timeoutMs);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.stdout.on('data', chunk => {
      stdout = Buffer.concat([stdout, chunk]);
      const text = stdout.toString('utf8');
      if (text.includes('"serverInfo"') && text.includes('chrome-cdp-ex')) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolvePromise({ ok: true, stderr });
      }
    });
    child.stdin.write(encodeMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'chrome-cdp-ex-setup', version: '0.0.0' },
      },
    }));
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function verifySetup({
  cdpScript = CDP_SCRIPT,
  mcpServer = MCP_SERVER,
} = {}) {
  const doctor = await runNodeScript(cdpScript, ['doctor', '--format', 'json']);
  let doctorModel = null;
  try {
    doctorModel = JSON.parse(doctor.stdout || '{}');
  } catch {
    doctorModel = { parseError: true, stdout: doctor.stdout, stderr: doctor.stderr };
  }
  let mcp = { ok: false };
  try {
    mcp = await verifyMcpInitialize({ mcpServer });
  } catch (error) {
    mcp = { ok: false, error: error.message || String(error) };
  }
  return {
    schema: 'chrome-cdp-ex.setup-verify.v1',
    doctorExitCode: doctor.code,
    doctor: doctorModel,
    mcp,
    routeRecommendation: routeRecommendation(),
    next: doctorModel?.recommendation?.run
      || doctorModel?.wizard?.currentStep
      || `${process.execPath} ${cdpScript} doctor`,
  };
}

function printDetect(detect) {
  const lines = [
    'chrome-cdp-ex setup --detect',
    `Repo:   ${detect.repoRoot}`,
    `Skill:  ${detect.skillDir}`,
    `CLI:    ${detect.node} ${detect.cdpScript}`,
    `MCP:    ${detect.node} ${detect.mcpServer}`,
    `Bin:    ${detect.binWrapper}`,
    `Node:   ${detect.nodeVersion}`,
    '',
    'Host install status:',
    `  claude skill: ${detect.hosts.claude.installed ? 'installed' : 'missing'} (${detect.hosts.claude.skillPath})`,
    `  codex skill:  ${detect.hosts.codex.installed ? 'installed' : 'missing'} (${detect.hosts.codex.skillPath})`,
    `  hermes skill: ${detect.hosts.hermes.installed ? 'installed' : 'missing'} (${detect.hosts.hermes.skillPath})`,
    `  cursor project MCP: ${detect.hosts.cursor.projectConfigured ? 'present' : 'missing'} (${detect.hosts.cursor.projectMcpPath})`,
    '',
    'Route recommendation:',
    JSON.stringify(routeRecommendation(), null, 2),
    '',
    'Next:',
    `  node ${join(detect.repoRoot, 'scripts', 'setup.mjs')} --for cursor`,
    `  node ${join(detect.repoRoot, 'scripts', 'setup.mjs')} --verify`,
  ];
  return lines.join('\n');
}

function usage() {
  return `Usage:
  node scripts/setup.mjs --detect
  node scripts/setup.mjs --for <${SUPPORTED_HOSTS.join('|')}> [--write] [--json]
  node scripts/setup.mjs --verify [--json]
  node scripts/setup.mjs --help

--for cursor --write   merges chrome-cdp-ex into ./.cursor/mcp.json
--for hermes --write   copies the skill into ~/.hermes/skills/chrome-cdp-ex
--for codex --write    copies the skill into ~/.codex/skills/chrome-cdp-ex
--json                 machine-readable output`;
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(usage());
    return 0;
  }
  const json = argv.includes('--json');
  const write = argv.includes('--write');
  const detect = opts.detect || detectEnvironment(opts);

  if (argv.includes('--detect')) {
    if (json) console.log(JSON.stringify(detect, null, 2));
    else console.log(printDetect(detect));
    return 0;
  }

  if (argv.includes('--verify')) {
    const result = await verifySetup();
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('chrome-cdp-ex setup --verify');
      console.log(`Doctor exit: ${result.doctorExitCode}`);
      console.log(`Doctor readiness: ${result.doctor?.readiness || result.doctor?.status || 'unknown'}`);
      console.log(`MCP initialize: ${result.mcp?.ok ? 'ok' : `failed (${result.mcp?.error || 'unknown'})`}`);
      console.log(`Next: ${result.next}`);
    }
    return result.mcp?.ok && result.doctor?.schema === 'chrome-cdp-ex.doctor.v1' ? 0 : 1;
  }

  const forIdx = argv.indexOf('--for');
  if (forIdx !== -1) {
    const host = argv[forIdx + 1];
    if (!host || host.startsWith('-')) {
      console.error('Missing host after --for');
      console.error(usage());
      return 2;
    }
    const snippet = hostSnippet(host, detect);
    const payload = {
      schema: 'chrome-cdp-ex.setup-for.v1',
      host,
      absolutePaths: {
        repoRoot: detect.repoRoot,
        skillDir: detect.skillDir,
        cdpScript: detect.cdpScript,
        mcpServer: detect.mcpServer,
        binWrapper: detect.binWrapper,
      },
      route: routeRecommendation()[host]
        || routeRecommendation()[`${host}-shell`]
        || routeRecommendation()[`${host}-code-skill`]
        || null,
      snippet,
      written: null,
    };
    if (host === 'cursor' && write) {
      payload.written = writeCursorMcpConfig({
        path: detect.hosts.cursor.projectMcpPath,
        mcpServer: detect.mcpServer,
        node: detect.node,
        cdpPort: detect.cdpPort,
      });
    } else if ((host === 'hermes' || host === 'codex') && write) {
      payload.written = writeHostSkill({
        dest: detect.hosts[host].skillPath,
        skillDir: detect.skillDir,
        fs: opts.fs,
      });
    }
    if (json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`chrome-cdp-ex setup --for ${host}`);
      console.log(`CLI: ${detect.node} ${detect.cdpScript}`);
      console.log(`MCP: ${detect.node} ${detect.mcpServer}`);
      console.log('');
      console.log(snippet);
      if (payload.written?.path) console.log(`\nWrote ${payload.written.path}`);
      else if (payload.written?.dest) console.log(`\nWrote ${payload.written.dest}`);
      else if (host === 'cursor') console.log('\nTip: add --write to merge into ./.cursor/mcp.json');
      else if (host === 'hermes') console.log(`\nTip: add --write to copy into ${detect.hosts.hermes.skillPath}`);
      else if (host === 'codex') console.log('\nTip: add --write to copy into ~/.codex/skills/chrome-cdp-ex');
    }
    return 0;
  }

  console.error(usage());
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}
