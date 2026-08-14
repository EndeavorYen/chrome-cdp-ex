import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  SUPPORTED_HOSTS,
  cursorMcpConfig,
  detectEnvironment,
  hostSnippet,
  main,
  routeRecommendation,
  writeCursorMcpConfig,
} from '../scripts/setup.mjs';
import {
  MCP_TOOL_DEFINITIONS,
  MCP_RUN_COMMAND_ALLOWLIST,
  buildMcpResourceCommand,
  buildMcpToolCommand,
  createMcpInitializeResult,
  listMcpResources,
} from '../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs';

describe('setup.mjs distribution helpers', () => {
  it('detects absolute runtime paths and supported hosts', () => {
    const detect = detectEnvironment();
    expect(detect.schema).toBe('chrome-cdp-ex.setup-detect.v1');
    expect(detect.cdpScript.endsWith('skills/chrome-cdp-ex/scripts/cdp.mjs')).toBe(true);
    expect(detect.mcpServer.endsWith('skills/chrome-cdp-ex/scripts/mcp-server.mjs')).toBe(true);
    expect(detect.filesPresent.skillMd).toBe(true);
    expect(SUPPORTED_HOSTS).toEqual(expect.arrayContaining(['claude', 'codex', 'cursor', 'openclaw', 'hermes', 'pi']));
  });

  it('prints host snippets with absolute paths', () => {
    const detect = detectEnvironment();
    for (const host of SUPPORTED_HOSTS) {
      const snippet = hostSnippet(host, detect);
      expect(snippet.length).toBeGreaterThan(20);
      if (host === 'cursor' || host === 'openclaw') {
        expect(snippet).toContain(detect.mcpServer);
      } else {
        expect(snippet).toContain(detect.cdpScript);
      }
    }
    expect(routeRecommendation().cursor).toBe('mcp');
    expect(routeRecommendation()['claude-code-skill']).toBe('cli');
  });

  it('merges Cursor MCP config without dropping existing servers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chrome-cdp-setup-'));
    try {
      const path = join(dir, '.cursor', 'mcp.json');
      mkdirSync(join(dir, '.cursor'), { recursive: true });
      writeFileSync(path, JSON.stringify({
        mcpServers: { other: { command: 'echo' } },
      }));
      const written = writeCursorMcpConfig({
        path,
        mcpServer: '/tmp/mcp-server.mjs',
        node: '/tmp/node',
        cdpPort: '9222',
      });
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      expect(parsed.mcpServers.other.command).toBe('echo');
      expect(parsed.mcpServers['chrome-cdp-ex'].command).toBe('/tmp/node');
      expect(parsed.mcpServers['chrome-cdp-ex'].args).toEqual(['/tmp/mcp-server.mjs']);
      expect(parsed.mcpServers['chrome-cdp-ex'].env.CDP_PORT).toBe('9222');
      expect(written.path).toBe(path);
      expect(cursorMcpConfig({ mcpServer: '/x', node: '/n' }).mcpServers['chrome-cdp-ex'].args).toEqual(['/x']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports Hermes skillPath and installed from a fake home', () => {
    const home = mkdtempSync(join(tmpdir(), 'chrome-cdp-hermes-detect-'));
    try {
      const missing = detectEnvironment({ home, env: {} });
      expect(missing.hosts.hermes.skillPath).toBe(join(home, '.hermes', 'skills', 'chrome-cdp-ex'));
      expect(missing.hosts.hermes.installed).toBe(false);
      expect(missing.hosts.hermes.route).toBe('cli');

      mkdirSync(join(home, '.hermes', 'skills', 'chrome-cdp-ex'), { recursive: true });
      const present = detectEnvironment({ home, env: {} });
      expect(present.hosts.hermes.skillPath).toBe(join(home, '.hermes', 'skills', 'chrome-cdp-ex'));
      expect(present.hosts.hermes.installed).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prints a Hermes copy into the skill parent without writing when --write is omitted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'chrome-cdp-hermes-print-'));
    try {
      const detect = detectEnvironment({ home, env: {} });
      const snippet = hostSnippet('hermes', detect);
      const dest = join(home, '.hermes', 'skills', 'chrome-cdp-ex');
      const parent = dirname(dest);
      expect(snippet).toContain(`cp -R '${detect.skillDir}' '${parent}/'`);
      expect(snippet).not.toContain(`cp -R '${detect.skillDir}' '${dest}'`);
      expect(snippet).not.toContain('<hermes-skills-dir>');
      const logs = [];
      const originalLog = console.log;
      console.log = (...args) => { logs.push(args.map(String).join(' ')); };
      try {
        const code = await main(['--for', 'hermes'], { home, env: {} });
        expect(code).toBe(0);
      } finally {
        console.log = originalLog;
      }
      expect(logs.join('\n')).toContain(dest);
      expect(existsSync(join(home, '.hermes'))).toBe(false);
      expect(existsSync(join(dest, 'SKILL.md'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('copies SKILL.md into dest/chrome-cdp-ex for --for hermes --write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'chrome-cdp-hermes-write-'));
    try {
      const dest = join(home, '.hermes', 'skills');
      const code = await main(['--for', 'hermes', '--write'], { home, env: {} });
      expect(code).toBe(0);
      expect(existsSync(join(dest, 'chrome-cdp-ex', 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('uses HERMES_HOME as the skill dest override', async () => {
    const home = mkdtempSync(join(tmpdir(), 'chrome-cdp-home-'));
    const hermesHome = mkdtempSync(join(tmpdir(), 'chrome-cdp-hermes-home-'));
    try {
      const detect = detectEnvironment({ home, env: { HERMES_HOME: hermesHome } });
      expect(detect.hosts.hermes.skillPath).toBe(join(hermesHome, 'skills', 'chrome-cdp-ex'));
      const code = await main(['--for', 'hermes', '--write'], {
        home,
        env: { HERMES_HOME: hermesHome },
      });
      expect(code).toBe(0);
      expect(existsSync(join(hermesHome, 'skills', 'chrome-cdp-ex', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.hermes'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(hermesHome, { recursive: true, force: true });
    }
  });
});

describe('MCP Tier-1 + run_command + resources', () => {
  it('exposes Tier-1 tools and maps them to CLI', () => {
    const names = MCP_TOOL_DEFINITIONS.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'navigate', 'press', 'wait_for', 'cascade', 'components',
      'spawn_debug_browser', 'record_snapshot', 'session_checkpoint', 'table', 'run_command',
    ]));
    expect(buildMcpToolCommand('navigate', { target: 'app', url: 'https://example.com', confirm: true }))
      .toEqual(['nav', 'app', 'https://example.com', '--format', 'json']);
    expect(buildMcpToolCommand('press', { target: 'app', key: 'Enter', confirm: true }))
      .toEqual(['press', 'app', 'Enter', '--format', 'json']);
    expect(buildMcpToolCommand('wait_for', { target: 'app', text: 'Saved', timeoutMs: 5000 }))
      .toEqual(['waitfor', 'app', '--text', 'Saved', '5000']);
    expect(buildMcpToolCommand('cascade', { target: 'app', selector: '@3', property: 'color' }))
      .toEqual(['cascade', 'app', '@3', 'color', '--format', 'json']);
    expect(() => buildMcpToolCommand('components', { target: 'app', selector: '@c1' }))
      .toThrow('components requires confirm: true');
    expect(buildMcpToolCommand('components', { target: 'app', selector: '@c1', confirm: true }))
      .toEqual(['components', 'app', '@c1', '--format', 'json']);
    expect(buildMcpToolCommand('spawn_debug_browser', {
      browser: 'edge', port: 9222, url: 'https://example.com', confirm: true,
    })).toEqual(['spawn-debug-browser', 'edge', '--port', '9222', '--url', 'https://example.com']);
    expect(buildMcpToolCommand('record_snapshot', { target: 'app', durationMs: 1000 }))
      .toEqual(['record', 'app', '1000']);
    expect(() => buildMcpToolCommand('session_checkpoint', { target: 'app' }))
      .toThrow(/confirm: true/);
    expect(buildMcpToolCommand('session_checkpoint', { target: 'app', confirm: true }))
      .toEqual(['checkpoint', 'app', '--format', 'json']);
  });

  it('gates run_command with allowlist + confirm for mutating commands', () => {
    expect(MCP_RUN_COMMAND_ALLOWLIST).toContain('cascade');
    expect(buildMcpToolCommand('run_command', { command: 'list', args: ['--format', 'json'] }))
      .toEqual(['list', '--format', 'json']);
    expect(() => buildMcpToolCommand('run_command', { command: 'rm', args: ['-rf', '/'] }))
      .toThrow(/not allowlisted/);
    expect(() => buildMcpToolCommand('run_command', { command: 'click', args: ['app', '@1'] }))
      .toThrow(/confirm: true/);
    expect(buildMcpToolCommand('run_command', { command: 'click', args: ['app', '@1'], confirm: true }))
      .toEqual(['click', 'app', '@1']);
    for (const [command, args] of [
      ['use', ['app', '--name', 'saved']],
      ['forget', ['saved']],
      ['tab-group', ['create', 'saved']],
      ['tab-group', ['--format', 'json', 'create', 'saved']],
      ['tab-group', ['--format', 'text', '--format', 'json', 'list']],
      ['loadall', ['app', '.more']],
      ['record', ['app', '--action', 'click', '@1']],
      ['keepalive', ['app', '60000']],
      ['console', ['app', '--clear']],
      ['netlog', ['app', '--clear']],
      ['diff-shot', ['app', '--reset']],
      ['shot', ['app', '/tmp/explicit.png']],
      ['fullshot', ['app', '/tmp/explicit-full.png']],
    ]) {
      expect(() => buildMcpToolCommand('run_command', { command, args }), command)
        .toThrow(/confirm: true/);
    }
    expect(buildMcpToolCommand('run_command', { command: 'tab-group', args: ['list'] }))
      .toEqual(['tab-group', 'list']);
    expect(buildMcpToolCommand('run_command', {
      command: 'tab-group', args: ['--format', 'json', 'show', 'saved'],
    })).toEqual(['tab-group', '--format', 'json', 'show', 'saved']);
    expect(buildMcpToolCommand('run_command', { command: 'console', args: ['app', '--errors'] }))
      .toEqual(['console', 'app', '--errors']);
    expect(buildMcpToolCommand('run_command', { command: 'shot', args: ['app', '--annotate'] }))
      .toEqual(['shot', 'app', '--annotate']);
    expect(buildMcpToolCommand('run_command', { command: 'table', args: ['app', '#grid'] }))
      .toEqual(['table', 'app', '#grid']);
    expect(buildMcpToolCommand('run_command', {
      command: 'table', args: ['app', '--continue', 'ct1.0123456789abcdef0123456789abcdef.0', '--format', 'json'],
    })).toEqual(['table', 'app', '--continue', 'ct1.0123456789abcdef0123456789abcdef.0', '--format', 'json']);
    expect(() => buildMcpToolCommand('run_command', {
      command: 'table', args: ['app', '#grid', '--collect', '--scroll-container', '.viewport'],
    })).toThrow(/confirm: true/);
    expect(buildMcpToolCommand('run_command', {
      command: 'table',
      args: ['app', '#grid', '--collect', '--scroll-container', '.viewport'],
      confirm: true,
    })).toEqual(['table', 'app', '#grid', '--collect', '--scroll-container', '.viewport']);
    expect(() => buildMcpToolCommand('run_command', {
      command: 'table', args: ['app', '#one', '#two'], confirm: true,
    })).toThrow(/at most one.*selector/);
    expect(buildMcpToolCommand('run_command', {
      command: 'use', args: ['app', '--name', 'saved'], confirm: true,
    })).toEqual(['use', 'app', '--name', 'saved']);
    expect(() => buildMcpToolCommand('run_command', { command: 'batch', args: ['app', 'eval raw'] }))
      .toThrow(/not allowlisted/);
    expect(() => buildMcpToolCommand('run_command', {
      command: 'checkpoint',
      args: ['app', '--unsafe-full'],
    })).toThrow(/confirm: true/);
    expect(() => buildMcpToolCommand('session_checkpoint', {
      target: 'app',
      unsafeFull: true,
    })).toThrow(/confirm: true/);
    expect(() => buildMcpToolCommand('screenshot', {
      target: 'app',
      path: '/tmp/explicit.png',
    })).toThrow(/confirm: true/);
    expect(buildMcpToolCommand('screenshot', {
      target: 'app',
      path: '/tmp/explicit.png',
      confirm: true,
    })).toEqual(['shot', 'app', '/tmp/explicit.png']);
  });

  it('maps resource URIs and advertises resources capability', () => {
    expect(buildMcpResourceCommand('chrome-cdp-ex://doctor/status'))
      .toEqual(['doctor', '--format', 'json']);
    expect(buildMcpResourceCommand('chrome-cdp-ex://session/app/report'))
      .toEqual(['report', 'app', '--compact', '--format', 'json']);
    expect(buildMcpResourceCommand('chrome-cdp-ex://session/app/screenshot/latest'))
      .toEqual(['shot', 'app']);
    expect(listMcpResources()[0].uri).toBe('chrome-cdp-ex://doctor/status');
    expect(createMcpInitializeResult().capabilities.resources).toEqual({});
  });
});
