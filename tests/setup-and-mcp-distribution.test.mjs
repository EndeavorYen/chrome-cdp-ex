import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  SUPPORTED_HOSTS,
  cursorMcpConfig,
  detectEnvironment,
  hostSnippet,
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
});

describe('MCP Tier-1 + run_command + resources', () => {
  it('exposes Tier-1 tools and maps them to CLI', () => {
    const names = MCP_TOOL_DEFINITIONS.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'navigate', 'press', 'wait_for', 'cascade', 'components',
      'spawn_debug_browser', 'record_snapshot', 'session_checkpoint', 'run_command',
    ]));
    expect(buildMcpToolCommand('navigate', { target: 'app', url: 'https://example.com', confirm: true }))
      .toEqual(['nav', 'app', 'https://example.com', '--format', 'json']);
    expect(buildMcpToolCommand('press', { target: 'app', key: 'Enter', confirm: true }))
      .toEqual(['press', 'app', 'Enter', '--format', 'json']);
    expect(buildMcpToolCommand('wait_for', { target: 'app', text: 'Saved', timeoutMs: 5000 }))
      .toEqual(['waitfor', 'app', '--text', 'Saved', '5000']);
    expect(buildMcpToolCommand('cascade', { target: 'app', selector: '@3', property: 'color' }))
      .toEqual(['cascade', 'app', '@3', 'color', '--format', 'json']);
    expect(buildMcpToolCommand('components', { target: 'app', selector: '@c1' }))
      .toEqual(['components', 'app', '@c1', '--format', 'json']);
    expect(buildMcpToolCommand('spawn_debug_browser', {
      browser: 'edge', port: 9222, url: 'https://example.com', confirm: true,
    })).toEqual(['spawn-debug-browser', 'edge', '--port', '9222', '--url', 'https://example.com']);
    expect(buildMcpToolCommand('record_snapshot', { target: 'app', durationMs: 1000 }))
      .toEqual(['record', 'app', '1000']);
    expect(buildMcpToolCommand('session_checkpoint', { target: 'app' }))
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
