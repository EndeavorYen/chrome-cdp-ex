import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runInNewContext } from 'node:vm';

process.env.NODE_ENV = 'test';

const { __test__: T, executeCdpCli } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const {
  MCP_TOOL_DEFINITIONS,
  buildMcpToolCommand,
  createMcpInitializeResult,
} = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');
const { COMMAND_SURFACE } = await import('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function encodeMcpMessage(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function parseMcpFrames(buffer) {
  const messages = [];
  let rest = buffer;
  while (rest.length) {
    const text = rest.toString('utf8');
    const headerEnd = text.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = text.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = Buffer.byteLength(text.slice(0, headerEnd + 4), 'utf8');
    if (rest.length < bodyStart + length) break;
    messages.push(JSON.parse(rest.slice(bodyStart, bodyStart + length).toString('utf8')));
    rest = rest.slice(bodyStart + length);
  }
  return { messages, rest };
}

describe('current open issue contracts', () => {
  it('#122 keeps operational readiness true for a usable checkout with only an install-path advisory', () => {
    const model = T.buildDoctorModel([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'WARN', label: 'Skill install', detail: '/tmp/checkout is not installed under ~/.claude/skills' },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['AABBCCDD'] },
      { status: 'OK', label: 'Permission', detail: 'approved', targetPrefixes: ['AABBCCDD'] },
    ]);

    expect(model).toMatchObject({
      status: 'usable-with-warnings',
      ready: true,
      operationalReady: true,
      failures: 0,
      warnings: 0,
      advisories: 1,
    });
    expect(model.checks.find(check => check.label === 'Skill install')?.severity).toBe('advisory');

    const actionableWarning = T.buildDoctorModel([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'WARN', label: 'FD limit', detail: '256 open files' },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['AABBCCDD'] },
      { status: 'OK', label: 'Permission', detail: 'approved', targetPrefixes: ['AABBCCDD'] },
    ]);
    expect(actionableWarning).toMatchObject({
      ready: false,
      operationalReady: false,
      warnings: 1,
    });
  });

  it('#123 returns a structured stop receipt for stopped and already-stopped targets', async () => {
    const daemon = {
      targetId: 'ABCDEF1234567890',
      socketPath: '/tmp/cdp-ABCDEF1234567890.sock',
    };
    const stopped = await T.stopDaemons('ABCDEF12', {
      list: () => [daemon],
      connect: async () => ({ end: () => {} }),
      send: async () => ({ ok: true, result: '' }),
    });
    const noop = await T.stopDaemons('ABCDEF12', { list: () => [] });
    const all = await T.stopDaemons(null, {
      list: () => [daemon, { targetId: '1234567890ABCDEF', socketPath: '/tmp/cdp-1234567890ABCDEF.sock' }],
      connect: async () => ({ end: () => {} }),
      send: async () => ({ ok: true, result: '' }),
    });
    const remainingDaemon = { targetId: '1234567890ABCDEF', socketPath: '/tmp/cdp-1234567890ABCDEF.sock' };
    const repeatedWithOtherSession = await T.stopDaemons('ABCDEF12', {
      list: () => [remainingDaemon],
    });
    const failedCleanup = await T.stopDaemons('ABCDEF12', {
      list: () => [daemon, remainingDaemon],
      connect: async () => { throw new Error('ECONNREFUSED'); },
      unlink: () => { throw new Error('EPERM'); },
    });

    expect(stopped).toMatchObject({
      schema: 'chrome-cdp-ex.stop.v1',
      requestedTarget: 'ABCDEF12',
      stopped: true,
      stoppedTargets: ['ABCDEF12'],
      remainingSessions: 0,
      noop: false,
    });
    expect(noop).toMatchObject({
      schema: 'chrome-cdp-ex.stop.v1',
      requestedTarget: 'ABCDEF12',
      stopped: false,
      stoppedTargets: [],
      remainingSessions: 0,
      noop: true,
    });
    expect(all).toMatchObject({
      requestedTarget: null,
      stopped: true,
      stoppedTargets: ['ABCDEF12', '12345678'],
      remainingSessions: 0,
      noop: false,
    });
    expect(repeatedWithOtherSession).toMatchObject({
      requestedTarget: 'ABCDEF12',
      stopped: false,
      remainingSessions: 1,
      remainingTargets: ['12345678'],
      noop: true,
    });
    expect(failedCleanup).toMatchObject({
      requestedTarget: 'ABCDEF12',
      stopped: false,
      failedTargets: ['ABCDEF12'],
      remainingSessions: 2,
      remainingTargets: ['ABCDEF12', '12345678'],
      noop: false,
    });
    expect(T.formatStopResult(stopped)).toContain('Stopped daemon ABCDEF12; 0 remaining session(s).');
    expect(T.formatStopResult(noop)).toContain('No active daemon for ABCDEF12; 0 remaining session(s).');
    expect(T.formatStopResult(all)).toContain('Stopped 2 daemon(s): ABCDEF12, 12345678; 0 remaining session(s).');
    expect(T.formatStopResult(failedCleanup)).toContain('Failed to stop daemon ABCDEF12; 2 remaining session(s).');
  });

  it('locks the #106-#109 issue-level helper contracts', async () => {
    expect(T.wrapAwaitExpression('const value = await Promise.resolve(42); value', true))
      .toBe('(async()=>{const value = await Promise.resolve(42); return (value);})()');
    expect(T.scrollSettledRectFunctionDeclaration()).toContain('maxSamples = fullyVisible ? 2 : 60');
    expect(T.parseConsoleArgs(['--clear', '--format', 'json'])).toEqual({ mode: 'clear', format: 'json' });
    expect(T.parseRepeatArgs(['20', 'click', '.attack', '--until-text', 'Battle complete'])).toMatchObject({
      count: 20,
      cmd: 'click',
      args: ['.attack'],
      condition: { kind: 'text', value: 'Battle complete' },
    });
    expect(T.parseFlowSteps('assert selector .done; assert text Battle complete')).toEqual([
      { kind: 'assert', condition: { kind: 'selector-exists', value: '.done' } },
      { kind: 'assert', condition: { kind: 'text', value: 'Battle complete' } },
    ]);
  });

  it('registers the issue-driven commands in the CLI metadata', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'verify-click',
      aliases: ['verifyclick'],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'settle-diff',
      outputFormats: ['text', 'json'],
    }));
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'qa',
      aliases: ['qa-page'],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'report-only',
      outputFormats: ['text', 'json'],
    }));
    for (const name of ['use', 'attach', 'forget', 'current']) {
      expect(T.COMMANDS).toContainEqual(expect.objectContaining({
        name,
        needsTarget: false,
      }));
    }
  });

  it('waits for spawned browser CDP readiness and supports headless recovery flags', async () => {
    const fs = {
      existsSync: path => path === '/opt/chromium/chrome',
      mkdirSync: () => {},
    };
    const child = {
      pid: 1234,
      unref: () => {},
      stdout: { on: () => {}, setEncoding: () => {}, unref: () => {} },
      stderr: { on: () => {}, setEncoding: () => {}, unref: () => {} },
      on: () => {},
      once: () => {},
    };
    const spawned = [];
    const out = await T.spawnDebugBrowserStr([
      'chrome',
      '--port', '9333',
      '--url', 'https://example.com',
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--exe', '/opt/chromium/chrome',
    ], { TMPDIR: '/tmp', PATH: '' }, {
      platform: 'linux',
      fs,
      spawn: (exe, args, opts) => {
        spawned.push({ exe, args, opts });
        return child;
      },
      probeTcpPort: async () => ({ occupied: false }),
      waitForSpawnedCdp: async ({ port }) => ({ ok: true, port, product: 'Chrome/126.0.0.0' }),
    });

    expect(spawned[0].args).toEqual(expect.arrayContaining([
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=9333',
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
    ]));
    expect(out).toContain('CDP ready');
    expect(out).toContain('Chrome/126.0.0.0');
    expect(out).toContain('CDP_PORT=9333');
  });

  it('reports early spawned-browser exits with captured stderr instead of success', async () => {
    const fs = {
      existsSync: path => path === '/opt/chromium/chrome',
      mkdirSync: () => {},
    };
    const child = {
      pid: 999,
      unref: () => {},
      stdout: { on: () => {}, setEncoding: () => {}, unref: () => {} },
      stderr: { on: () => {}, setEncoding: () => {}, unref: () => {} },
      on: () => {},
      once: () => {},
    };

    await expect(T.spawnDebugBrowserStr(['chrome', '--exe', '/opt/chromium/chrome'], {}, {
      platform: 'linux',
      fs,
      spawn: () => child,
      probeTcpPort: async () => ({ occupied: false }),
      waitForSpawnedCdp: async () => ({
        ok: false,
        exited: true,
        exitCode: 1,
        stderr: 'zygote host requires --no-sandbox',
      }),
    })).rejects.toThrow(/exited early.*zygote host requires --no-sandbox/s);
  });

  it('makes doctor recommendations environment-aware for remote headless Linux', async () => {
    const fs = {
      existsSync: path => path === '/usr/bin/chromium' || path.endsWith('package.json'),
      lstatSync: () => ({ isDirectory: () => false, isSymbolicLink: () => false }),
    };
    const fetcher = async () => {
      throw new Error('ECONNREFUSED');
    };
    const checks = await T.runDoctorChecks({
      nodeVersion: 'v22.1.0',
      platform: 'linux',
      fdLimit: 4096,
      home: '/home/agent',
      env: { PATH: '/usr/bin', CI: 'true' },
      fs,
      fetcher,
      listDaemons: () => [],
      lastEndpoint: null,
    });
    const model = T.buildDoctorModel(checks);

    expect(checks).toContainEqual(expect.objectContaining({
      label: 'Environment',
      status: 'WARN',
    }));
    expect(model.recommendation).toMatchObject({
      stage: 'browser-cdp',
      run: 'cdp spawn-debug-browser chrome --headless --no-sandbox --port 9222 --exe /usr/bin/chromium --url https://example.com',
      consentRequired: true,
    });
    expect(model.recommendation.reason).toContain('headless');
    expect(model.nextSteps[0]).toBe(model.recommendation.run);
  });

  it('stores named target aliases outside the repository and renders them in list output', () => {
    const store = T.upsertTargetAlias(T.emptyAliasStore(), {
      name: 'app',
      targetId: '52A8B23D000000000000000000000001',
      port: 9223,
      url: 'http://127.0.0.1:8787',
      title: 'Local app',
      now: Date.parse('2026-07-07T00:00:00.000Z'),
    });
    const resolved = T.resolveTargetAlias('app', store);
    const text = T.formatPageList([
      {
        targetId: '52A8B23D000000000000000000000001',
        title: 'Local app',
        url: 'http://127.0.0.1:8787',
      },
    ], null, { aliases: store.aliases });

    expect(resolved).toMatchObject({
      name: 'app',
      targetId: '52A8B23D000000000000000000000001',
      port: 9223,
    });
    expect(store.current).toBe('app');
    expect(text).toContain('@app');
  });

  it('builds concise semantic click assertions from action evidence', () => {
    const action = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC12345', input: 'button[data-action="checkpoint"]', label: 'checkpoint' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 95 },
      effects: {
        domDiff: '+++ Added (1):\n+   [status] Recorded checkpoint',
        console: [],
        network: [],
        navigation: null,
      },
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 0,
        pending: 0,
        entries: [{ method: 'POST', url: 'https://app.test/api/checkpoint', status: 200, duration: 31 }],
      },
    });
    const opts = T.parseVerifyClickArgs([
      'button[data-action="checkpoint"]',
      '--expect-request', 'POST /api/checkpoint',
      '--expect-status', '200',
      '--expect-text', 'Recorded checkpoint',
      '--no-console-errors',
    ]);
    const model = T.buildSemanticInteractionModel(action, opts, { textMatched: true });
    const text = T.formatSemanticInteractionResult(model);

    expect(model.verdict).toBe('pass');
    expect(model.assertions.map(assertion => assertion.status)).toEqual(['pass', 'pass', 'pass']);
    expect(text).toContain('Request: POST /api/checkpoint -> 200 matched');
    expect(text).toContain('Text: "Recorded checkpoint" matched');
    expect(text).toContain('Console: clean');
    expect(text).toContain('Verdict: pass');
  });

  it('builds a bounded QA page report with screenshots and semantic action evidence', () => {
    const actionModel = {
      schema: 'chrome-cdp-ex.semantic-interaction.v1',
      action: 'click',
      target: 'button.primary',
      verdict: 'pass',
      assertions: [{ kind: 'text', status: 'pass', expected: 'Saved' }],
    };
    const model = T.buildQaPageModel({
      targetId: 'ABC123456789',
      page: { title: 'App', url: 'http://127.0.0.1:8787' },
      console: { errors: 0, warnings: 0, exceptions: 0 },
      perception: { captured: true, summary: 'Page: App' },
      screenshots: {
        desktop: { viewport: '1440x900', path: '/tmp/desktop.png' },
        mobile: { viewport: '390x844', path: '/tmp/mobile.png' },
      },
      action: actionModel,
      assertions: [{ kind: 'text', status: 'pass', expected: 'Saved', message: '"Saved" matched' }],
    });
    const text = T.formatQaPageReport(model);

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.qa-page.v1',
      targetPrefix: 'ABC12345',
      verdict: 'pass',
      checks: {
        page: 'pass',
        console: 'pass',
        desktopScreenshot: 'pass',
        mobileScreenshot: 'pass',
        assertions: 'pass',
        action: 'pass',
      },
    });
    expect(text).toContain('Page: pass');
    expect(text).toContain('Desktop screenshot: /tmp/desktop.png');
    expect(text).toContain('Mobile screenshot: /tmp/mobile.png');
    expect(text).toContain('Action: pass');
    expect(text).toContain('Assertions:');
    expect(text).toContain('Verdict: pass');
  });

  it('exposes MCP tool descriptors and maps typed calls to cdp commands', () => {
    const toolNames = MCP_TOOL_DEFINITIONS.map(tool => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining([
      'doctor',
      'open_or_attach',
      'select_target',
      'list_tabs',
      'perceive',
      'controls',
      'overlay',
      'screenshot',
      'click',
      'verify_click',
      'dismiss_modal',
      'fill',
      'viewport',
      'qa_page',
      'responsive_audit',
      'report',
      'navigate',
      'press',
      'wait_for',
      'cascade',
      'components',
      'spawn_debug_browser',
      'record_snapshot',
      'session_checkpoint',
      'run_command',
    ]));
    expect(createMcpInitializeResult().serverInfo.name).toBe('chrome-cdp-ex');
    expect(createMcpInitializeResult().serverInfo.version).toBe(packageJson.version);
    expect(buildMcpToolCommand('doctor', {})).toEqual(['doctor', '--format', 'json']);
    expect(buildMcpToolCommand('perceive', { target: 'app', depth: 4, cursorInteractive: true }))
      .toEqual(['perceive', 'app', '-d', '4', '-C', '--adaptive', '--format', 'json']);
    expect(buildMcpToolCommand('perceive', { target: 'app', cards: true, last: 12 }))
      .toEqual(['perceive', 'app', '--cards', '--last', '12', '--format', 'json']);
    expect(buildMcpToolCommand('perceive', { target: 'app', qa: true, maxDiffLines: 12 }))
      .toEqual(['perceive', 'app', '--adaptive', '--qa', '--max-diff-lines', '12', '--format', 'json']);
    expect(buildMcpToolCommand('controls', { target: 'app', selector: '#composer', filter: 'send', limit: 5 }))
      .toEqual(['controls', 'app', '--selector', '#composer', '--filter', 'send', '--limit', '5', '--compact', '--format', 'json']);
    expect(buildMcpToolCommand('overlay', { target: 'app', selector: '@3' }))
      .toEqual(['overlay', 'app', '@3', '--format', 'json']);
    expect(buildMcpToolCommand('open_or_attach', { target: 'ABC12345', port: 9223 }))
      .toEqual(['use', '--port', '9223', '--target', 'ABC12345']);
    expect(buildMcpToolCommand('open_or_attach', { url: 'https://example.com', reuseUrl: true, confirm: true }))
      .toEqual(['open', 'https://example.com', '--reuse-url', '--format', 'json']);
    expect(buildMcpToolCommand('select_target', { url: '8788', title: 'Lab' }))
      .toEqual(['target', '--url', '8788', '--title', 'Lab', '--format', 'json']);
    expect(buildMcpToolCommand('click', { target: 'app', selector: 'button.primary', confirm: true }))
      .toEqual(['click', 'app', 'button.primary', '--format', 'json']);
    expect(buildMcpToolCommand('click', { target: 'app', selector: 'button.primary', qa: true, confirm: true }))
      .toEqual(['click', 'app', 'button.primary', '--qa', '--format', 'json']);
    expect(buildMcpToolCommand('verify_click', {
      target: 'app',
      selector: 'button.primary',
      expectText: 'Saved',
      expectRequest: 'POST /api/save',
      expectStatus: 200,
      noConsoleErrors: true,
      confirm: true,
    })).toEqual([
      'verify-click', 'app', 'button.primary',
      '--expect-text', 'Saved',
      '--expect-request', 'POST /api/save',
      '--expect-status', '200',
      '--no-console-errors',
      '--format', 'json',
    ]);
    expect(buildMcpToolCommand('dismiss_modal', { target: 'app', confirm: true }))
      .toEqual(['dismiss-modal', 'app', '--format', 'json']);
    expect(() => buildMcpToolCommand('fill', { target: 'app', selector: '#password', text: 'secret' }))
      .toThrow(/confirm: true/);
    expect(() => buildMcpToolCommand('dismiss_modal', { target: 'app' }))
      .toThrow(/confirm: true/);
    expect(buildMcpToolCommand('qa_page', {
      target: 'app',
      desktop: '1440x900',
      mobile: '390x844',
      click: 'button.primary',
      expectText: 'Saved',
      confirm: true,
    })).toEqual([
      'qa', 'app',
      '--desktop', '1440x900',
      '--mobile', '390x844',
      '--click', 'button.primary',
      '--expect-text', 'Saved',
      '--format', 'json',
    ]);
    expect(() => buildMcpToolCommand('qa_page', { target: 'app' }))
      .toThrow(/confirm: true/);
    expect(buildMcpToolCommand('responsive_audit', {
      target: 'app',
      viewports: ['1440x900', '390x844'],
      outDir: '/tmp/audit',
      maxControls: 5,
      confirm: true,
    })).toEqual([
      'responsive-audit', 'app',
      '--viewport', '1440x900',
      '--viewport', '390x844',
      '--out-dir', '/tmp/audit',
      '--max-controls', '5',
      '--format', 'json',
    ]);
    expect(() => buildMcpToolCommand('responsive_audit', { target: 'app' }))
      .toThrow(/confirm: true/);
    expect(buildMcpToolCommand('report', { target: 'app', qa: true, last: 3 }))
      .toEqual(['report', 'app', '--last', '3', '--qa', '--format', 'json']);
  });

  it('serves framed MCP initialize and tool-list requests in order over stdio', async () => {
    const child = spawn(process.execPath, ['skills/chrome-cdp-ex/scripts/mcp-server.mjs'], {
      cwd: new URL('..', import.meta.url),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = '';

    const responses = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP server timeout: ${stderr}`)), 3000);
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.stdout.on('data', chunk => {
        stdout = Buffer.concat([stdout, chunk]);
        const parsed = parseMcpFrames(stdout);
        if (parsed.messages.length >= 2) {
          clearTimeout(timer);
          resolve(parsed.messages.slice(0, 2));
        }
      });
      child.on('error', reject);
      child.stdin.write(encodeMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
      child.stdin.write(encodeMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    });

    child.kill();
    expect(responses.map(response => response.id)).toEqual([1, 2]);
    expect(responses[0].result.protocolVersion).toBe('2024-11-05');
    expect(responses[1].result.tools.map(tool => tool.name)).toContain('qa_page');
  });
});


describe('issues #82-#87 contracts', () => {
  it('#82 selects targets by URL/title and errors on ambiguity', () => {
    const pages = [
      { targetId: 'AAAABBBB11112222', title: 'Blank', url: 'about:blank' },
      { targetId: 'CCCCDDDD33334444', title: 'Agent Decision Lab', url: 'http://127.0.0.1:8788/app' },
      { targetId: 'EEEEFFFF55556666', title: 'Other', url: 'http://127.0.0.1:8788/other' },
    ];
    const selected = T.selectPageTarget(pages, { url: '8788/app' });
    expect(selected).toMatchObject({
      targetId: 'CCCCDDDD33334444',
      targetPrefix: expect.stringMatching(/^CCCC/),
    });
    expect(T.formatTargetSelect(selected, pages)).toContain('Selected target:');
    expect(T.parseOpenArgs(['https://example.com', '--reuse-url']).reuseUrl).toBe(true);
    expect(() => T.selectPageTarget(pages, { url: '8788' })).toThrow(/2 pages matched/);
    expect(T.rankPageTargets(pages)[0].url).toContain('8788');
  });

  it('#83 returns spawn target handoff model with cleanup guidance', async () => {
    const out = await T.spawnDebugBrowserStr([
      'chrome', '--port', '9444', '--url', 'https://example.com', '--exe', '/opt/chromium/chrome', '--format', 'json',
    ], { TMPDIR: '/tmp', PATH: '' }, {
      platform: 'linux',
      fs: { existsSync: path => path === '/opt/chromium/chrome', mkdirSync: () => {} },
      spawn: () => ({
        pid: 777,
        unref: () => {},
        stdout: { on: () => {}, setEncoding: () => {}, unref: () => {} },
        stderr: { on: () => {}, setEncoding: () => {}, unref: () => {} },
        on: () => {},
        once: () => {},
      }),
      probeTcpPort: async () => ({ occupied: false }),
      waitForSpawnedCdp: async () => ({ ok: true, port: 9444, product: 'Chrome/126' }),
      listSpawnedDebugTargets: async () => ([
        { targetId: 'TARGETID00000001', title: 'Example', url: 'https://example.com', type: 'page' },
      ]),
    });
    const model = JSON.parse(out);
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.spawn-debug-browser.v1',
      ready: true,
      pid: 777,
      port: 9444,
      url: 'https://example.com',
      targetId: 'TARGETID00000001',
      targetPrefix: expect.any(String),
    });
    expect(model.nextCommand).toMatch(/perceive .* -C -d 8/);
    expect(model.cleanup.deleteProfile).toContain(model.profileDir);
  });

  it('#84 builds compact QA summary models for action handoffs', () => {
    const summary = T.buildQaSummaryModel({
      page: { url: 'http://127.0.0.1:8787', title: 'App' },
      console: { errors: 0, exceptions: 0 },
      network: { failures: 0 },
      action: { outcome: 'changed', dispatch: { ok: true }, changed: true },
      targetPrefix: 'ABC12345',
      nextCommand: 'cdp report ABC12345',
      source: 'action',
    });
    expect(summary).toMatchObject({
      schema: 'chrome-cdp-ex.qa-summary.v1',
      ok: true,
      changed: 'changed',
      consoleErrors: 0,
      networkFailures: 0,
    });
    expect(T.formatQaSummaryText(summary)).toContain('QA summary: pass');
    const parsed = T.parseQaModeArgs(['--qa', '--max-diff-lines', '5', 'extra']);
    expect(parsed).toMatchObject({ qa: true, compact: true, maxDiffLines: 5, args: ['extra'] });
    expect(T.parseReportArgs(['--qa', '--last', '3'])).toMatchObject({ qa: true, compact: true, lastActions: 3 });
  });

  it('#85 improves text no-match diagnostics with root/scope and eval fallback', () => {
    expect(T.parseTextArgs(['--root', 'document', '#promptBlock']).root).toBe('document');
    const err = T.formatTextNoMatchError(
      { tried: ['#promptBlock'], root: 'body' },
      { selectors: ['#promptBlock'], root: 'body' },
    );
    expect(err).toContain('within root "body"');
    expect(err).toContain('document.querySelector("#promptBlock")');
    expect(err).toContain('text --root');
    // Explicit selectors default to document-wide search (matches eval querySelector).
    const script = T.textPageScript({ selectors: ['#promptBlock'] });
    expect(script).toContain('document');
    expect(script).toMatch(/setting === 'document'|sel: 'document'/);
  });

  it('#86 builds responsive audit pass/warn/fail summaries', () => {
    const model = T.buildResponsiveAuditModel({
      targetId: 'ABCDEF0123456789',
      page: { title: 'App', url: 'http://127.0.0.1:8787' },
      console: { errors: 0, warnings: 0, exceptions: 0 },
      viewports: [
        {
          viewport: '1440x900',
          url: 'http://127.0.0.1:8787',
          title: 'App',
          screenshot: '/tmp/desktop.png',
          overflowX: false,
          blank: false,
          controlCount: 4,
          scroll: { width: 1440, height: 900, clientWidth: 1440, clientHeight: 900 },
        },
        {
          viewport: '390x844',
          url: 'http://127.0.0.1:8787',
          title: 'App',
          screenshot: '/tmp/mobile.png',
          overflowX: true,
          blank: false,
          controlCount: 3,
          scroll: { width: 420, height: 1200, clientWidth: 390, clientHeight: 844 },
        },
      ],
    });
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.responsive-audit.v1',
      verdict: 'warn',
      summary: { pass: 1, warn: 1, fail: 0 },
    });
    expect(T.formatResponsiveAuditReport(model)).toContain('Responsive audit: warn');
    expect(T.parseResponsiveAuditArgs([]).viewports).toEqual(['1440x900', '390x844']);
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'responsive-audit',
      aliases: ['visual-check'],
      needsTarget: true,
    }));
  });

  it('#87 classifies doctor permission as advisory and readiness as usable-with-warnings', () => {
    const permission = T.checkBrowserPermission({
      daemons: { targetPrefixes: [] },
      tabs: { status: 'OK', targetPrefixes: ['AABBCCDD'] },
      cdp: { status: 'OK' },
      environment: { environment: { headlessLikely: true } },
    });
    expect(permission.severity).toBe('advisory');
    expect(permission.detail).toMatch(/headless CDP is reachable/i);

    const summary = T.doctorStatusSummary([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'CDP', detail: 'ok' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['AABBCCDD'] },
      permission,
    ]);
    expect(summary).toMatchObject({
      readiness: 'usable-with-warnings',
      status: 'usable-with-warnings',
      failures: 0,
      advisories: 1,
    });
    const model = T.buildDoctorModel([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'CDP', detail: 'ok' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['AABBCCDD'] },
      permission,
    ]);
    expect(model.provenCommand).toBeTruthy();
    expect(model.checks.find(c => c.label === 'Permission').severity).toBe('advisory');
    expect(model.wizard.status).toMatch(/usable with advisory/i);
    expect(model.recommendation).toMatchObject({
      stage: 'perceive',
      requiresUserAction: false,
      ask: null,
    });
  });
});


describe('issues #89-#91 contracts', () => {
  it('#89 maps new MCP tools for target selection and responsive audit', () => {
    expect(MCP_TOOL_DEFINITIONS.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'select_target',
      'responsive_audit',
    ]));
    expect(buildMcpToolCommand('select_target', { url: 'http://127.0.0.1:8788', exact: true }))
      .toEqual(['target', '--url', 'http://127.0.0.1:8788', '--exact', '--format', 'json']);
    expect(() => buildMcpToolCommand('responsive_audit', { target: 'app' }))
      .toThrow(/confirm: true/);
    expect(buildMcpToolCommand('responsive_audit', { target: 'app', confirm: true }))
      .toEqual(['responsive-audit', 'app', '--format', 'json']);
  });

  it('#90 applies max-controls and reports network failures in QA helpers', () => {
    const script = T.responsiveAuditViewportScript({ maxControls: 2 });
    expect(script).toContain('slice(0, 2)');
    expect(script).toContain('maxControls: 2');
    const fakeBuf = {
      all: () => ([
        { status: 200, url: 'https://ok' },
        { status: 500, url: 'https://fail', failed: true },
        { status: 404, url: 'https://missing' },
      ]),
    };
    expect(T.countNetworkFailures(fakeBuf)).toBeGreaterThanOrEqual(1);
    const summary = T.buildQaSummaryModel({
      page: { url: 'https://app', title: 'App' },
      console: { errors: 0, exceptions: 0 },
      network: { failures: T.countNetworkFailures(fakeBuf) },
      targetPrefix: 'ABC',
      source: 'perceive',
    });
    expect(summary.networkFailures).toBeGreaterThan(0);
    expect(T.parseResponsiveAuditArgs(['--max-controls', '3']).maxControls).toBe(3);
  });

  it('#91 provides styles no-match diagnostics with root/scope', () => {
    // Pure parser parity with text/html root flags.
    expect(T.parseTextArgs(['--root', 'body', '.chip']).root).toBe('body');
    expect(T.parseTextArgs(['.chip']).selectors).toEqual(['.chip']);
  });
});

describe('issue #115 responsive internal geometry contracts', () => {
  it('warns on bounded clipped controls and material control overlap', () => {
    const model = T.buildResponsiveAuditModel({
      targetId: 'ABCDEF0123456789',
      page: { title: 'App', url: 'http://127.0.0.1:8787' },
      console: { errors: 0, warnings: 0, exceptions: 0 },
      viewports: [{
        viewport: '390x844',
        url: 'http://127.0.0.1:8787',
        title: 'App',
        screenshot: '/tmp/mobile.png',
        overflowX: false,
        blank: false,
        controlCount: 4,
        clippedControls: [
          {
            selector: '#hidden-route',
            name: 'Continue',
            severity: 'warning',
            clippedRatio: 0.75,
            elementRect: { x: 420, y: 20, width: 100, height: 40 },
            containerRect: { x: 0, y: 0, width: 390, height: 120 },
          },
          {
            selector: '#intentional-item',
            name: 'Later item',
            severity: 'info',
            suppressed: true,
            suppression: 'intentional-scroll-container',
          },
        ],
        overlaps: [{
          selector: '#save',
          name: 'Save',
          occluderSelector: '.command-bar',
          occluderName: 'Commands',
          severity: 'warning',
          overlapRatio: 0.4,
          elementRect: { x: 10, y: 700, width: 120, height: 40 },
          occluderRect: { x: 0, y: 680, width: 390, height: 80 },
        }],
      }],
    });

    expect(model.verdict).toBe('warn');
    expect(model.viewports[0].findings).toMatchObject({
      clippedControls: [expect.objectContaining({ selector: '#hidden-route', clippedRatio: 0.75 })],
      overlaps: [expect.objectContaining({ selector: '#save', overlapRatio: 0.4 })],
      suppressed: 1,
    });
    expect(model.viewports[0].findings.clippedControls).toHaveLength(1);
    expect(T.formatResponsiveAuditReport(model)).toContain('clipped=1 overlap=1');
  });

  it('collects container clipping and overlap evidence in the viewport probe', () => {
    const script = T.responsiveAuditViewportScript({ maxControls: 4 });
    expect(script).toContain('nearestScrollable');
    expect(script).toContain('clippedControls');
    expect(script).toContain('overlapRatio');
    expect(script).toContain('data-cdp-audit-scroll');
  });

  it('keeps clean responsive fixtures passing and carries screenshot capture metadata', () => {
    const model = T.buildResponsiveAuditModel({
      targetId: 'ABCDEF0123456789',
      page: { title: 'Clean', url: 'https://example.test' },
      console: { errors: 0, warnings: 0, exceptions: 0 },
      viewports: [{
        viewport: '1440x900',
        overflowX: false,
        blank: false,
        clippedControls: [],
        overlaps: [],
        screenshotCapture: { method: 'captureScreenshot', retryCount: 0 },
      }],
    });

    expect(model.verdict).toBe('pass');
    expect(model.viewports[0].screenshotCapture).toEqual({ method: 'captureScreenshot', retryCount: 0 });
  });

  it('fails a viewport whose screenshot remains contradictory after retry', () => {
    const model = T.buildResponsiveAuditModel({
      targetId: 'ABCDEF0123456789',
      viewports: [{
        viewport: '390x844',
        overflowX: false,
        blank: false,
        clippedControls: [],
        overlaps: [],
        screenshotCapture: {
          method: 'captureScreenshot-fromSurface-false',
          retryCount: 1,
          sanity: { retry: true, reason: 'near-black-frame-on-light-page' },
        },
      }],
    });

    expect(model.verdict).toBe('fail');
    expect(model.viewports[0].status).toBe('fail');
  });

  it('executes the viewport probe without treating hidden surfaces as occluders', () => {
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 };
    const body = {
      parentElement: null,
      innerText: 'Save',
      textContent: 'Save',
      getBoundingClientRect: () => ({ ...rect, width: 390, height: 844 }),
    };
    const control = {
      id: 'save', tagName: 'BUTTON', parentElement: body, innerText: 'Save', value: '', title: '',
      getAttribute: () => null,
      getBoundingClientRect: () => rect,
      contains: () => false,
    };
    const hiddenSurface = {
      id: 'hidden-dialog', tagName: 'DIALOG', parentElement: body, innerText: '', value: '', title: '',
      getAttribute: () => null,
      getBoundingClientRect: () => rect,
      contains: () => false,
      matches: selector => selector.includes('dialog'),
    };
    const document = {
      documentElement: { scrollWidth: 390, scrollHeight: 844, clientWidth: 390, clientHeight: 844 },
      body,
      title: 'Fixture',
      readyState: 'complete',
      querySelectorAll: selector => selector === 'body *' ? [hiddenSurface]
        : selector === '*' ? [control, hiddenSurface]
          : [control],
      elementFromPoint: () => hiddenSurface,
    };
    const output = runInNewContext(T.responsiveAuditViewportScript({ maxControls: 4 }), {
      document,
      window: { innerWidth: 390, innerHeight: 844 },
      location: { href: 'https://example.test' },
      CSS: { escape: value => value },
      getComputedStyle: element => element === hiddenSurface
        ? { position: 'fixed', visibility: 'hidden', display: 'block', opacity: '1', pointerEvents: 'auto', overflowX: 'visible', overflowY: 'visible' }
        : { position: 'static', visibility: 'visible', display: 'block', opacity: '1', pointerEvents: 'auto', overflowX: 'visible', overflowY: 'visible' },
    });

    expect(JSON.parse(output).overlaps).toEqual([]);
  });
});

describe('issue #118 shared blank-page classification', () => {
  it('classifies populated, empty, and loading page signals consistently', () => {
    expect(T.classifyPageHealth).toBeTypeOf('function');

    expect(T.classifyPageHealth({
      url: '',
      readyState: 'complete',
      visibleTextLength: 24,
      elementCount: 12,
      visibleControlCount: 2,
      bodyRect: { width: 390, height: 844 },
      changed: true,
    })).toMatchObject({ status: 'populated', isBlank: false });

    expect(T.classifyPageHealth({
      url: 'https://example.test/empty',
      readyState: 'complete',
      visibleTextLength: 0,
      elementCount: 3,
      visibleControlCount: 0,
      bodyRect: { width: 390, height: 0 },
      changed: false,
    })).toMatchObject({ status: 'blank', isBlank: true });

    expect(T.classifyPageHealth({
      url: 'https://example.test/loading',
      readyState: 'loading',
      visibleTextLength: 0,
      elementCount: 3,
      visibleControlCount: 0,
      bodyRect: { width: 390, height: 0 },
    })).toMatchObject({ status: 'indeterminate', isBlank: false });
  });

  it('uses populated health evidence instead of treating a missing action URL as blank', () => {
    const summary = T.buildQaSummaryModel({
      page: { url: '', title: '' },
      pageHealth: {
        status: 'populated',
        isBlank: false,
        confidence: 'high',
        evidence: { visibleTextLength: 24, visibleControlCount: 2, changed: true },
      },
      console: { errors: 0, exceptions: 0 },
      network: { failures: 0 },
      action: { outcome: 'changed', dispatch: { ok: true }, changed: true },
      source: 'action',
    });

    expect(summary.ok).toBe(true);
    expect(summary.page).toMatchObject({ isBlank: false, healthStatus: 'populated' });
    expect(summary.pageHealth.evidence).toMatchObject({ changed: true });
  });

  it('renders indeterminate page health as review rather than pass', () => {
    const model = T.buildQaSummaryModel({
      page: { title: 'Loading', url: 'https://example.test' },
      pageHealth: T.classifyPageHealth({ readyState: 'loading' }),
    });

    expect(model.ok).toBe(false);
    expect(T.formatQaSummaryText(model)).toContain('Page health: indeterminate');
  });
});

describe('issue #119 live target binding contracts', () => {
  const livePages = [
    { targetId: 'AAAABBBB11112222', title: 'Blank', url: 'about:blank' },
    { targetId: 'CCCCDDDD33334444', title: 'Agent Decision Lab', url: 'http://127.0.0.1:8788/app' },
  ];

  it('resolves the requested populated target from live discovery instead of a stale blank daemon', () => {
    expect(T.resolveLiveTargetBinding).toBeTypeOf('function');
    const binding = T.resolveLiveTargetBinding({
      requested: 'CCCCDDDD',
      livePages,
      daemonBinding: {
        targetId: 'CCCCDDDD33334444',
        boundTargetId: 'AAAABBBB11112222',
      },
    });

    expect(binding).toMatchObject({
      schema: 'chrome-cdp-ex.target-resolution.v1',
      requestedTargetPrefix: 'CCCCDDDD',
      requestedTargetId: 'CCCCDDDD33334444',
      boundTargetId: 'AAAABBBB11112222',
      resolvedTargetId: 'CCCCDDDD33334444',
      resolutionSource: 'live-discovery',
      status: 'rebind-required',
      rebindRequired: true,
    });
  });

  it('reuses matching target daemons and preserves ambiguity errors', () => {
    const binding = T.resolveLiveTargetBinding({
      requested: 'CCCCDDDD',
      livePages,
      daemonBinding: {
        targetId: 'CCCCDDDD33334444',
        boundTargetId: 'CCCCDDDD33334444',
      },
    });
    expect(binding).toMatchObject({ status: 'reused', rebindRequired: false });

    expect(() => T.resolveLiveTargetBinding({
      requested: 'CCCC',
      livePages: [
        ...livePages,
        { targetId: 'CCCCEEEE55556666', title: 'Other', url: 'http://127.0.0.1:8788/other' },
      ],
    })).toThrow(/ambiguous/i);
  });

  it('attaches bounded requested, bound, and resolved ids to structured CLI output', () => {
    const diagnostic = {
      schema: 'chrome-cdp-ex.target-resolution.v1',
      requestedTargetPrefix: 'CCCCDDDD',
      requestedTargetId: 'CCCCDDDD33334444',
      boundTargetId: 'CCCCDDDD33334444',
      resolvedTargetId: 'CCCCDDDD33334444',
      resolutionSource: 'live-discovery',
      status: 'rebound',
      rebindRequired: false,
      rebound: true,
    };
    const output = T.attachTargetResolutionDiagnostics(JSON.stringify({
      schema: 'chrome-cdp-ex.perception.v1',
      page: { url: 'http://127.0.0.1:8788/app' },
    }), diagnostic);

    expect(JSON.parse(output).targetResolution).toEqual({
      requestedTargetPrefix: 'CCCCDDDD',
      requestedTargetId: 'CCCCDDDD33334444',
      boundTargetId: 'CCCCDDDD33334444',
      resolvedTargetId: 'CCCCDDDD33334444',
      resolutionSource: 'live-discovery',
      status: 'rebound',
      rebound: true,
    });
    expect(output.length).toBeLessThan(500);
  });

  it('collapses identical target ids in compact CLI output', () => {
    const targetId = 'CCCCDDDD33334444';
    const output = T.attachTargetResolutionDiagnostics(JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1',
      mode: 'compact',
      action: 'click',
    }), {
      requestedTargetPrefix: 'CCCCDDDD',
      requestedTargetId: targetId,
      boundTargetId: targetId,
      resolvedTargetId: targetId,
      resolutionSource: 'live-discovery',
      status: 'reused',
      rebound: false,
    });

    expect(JSON.parse(output).targetResolution).toEqual({
      requestedTargetPrefix: 'CCCCDDDD',
      targetId,
      status: 'reused',
      rebound: false,
    });
    expect(output.length).toBeLessThan(300);
    expect(output).not.toContain('\n');
  });

  it('keeps full target diagnostics in compact output when the target changed', () => {
    const output = T.attachTargetResolutionDiagnostics(JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1',
      mode: 'compact',
      action: 'click',
    }), {
      requestedTargetPrefix: 'CCCCDDDD',
      requestedTargetId: 'CCCCDDDD33334444',
      boundTargetId: 'AAAABBBB11112222',
      resolvedTargetId: 'CCCCDDDD33334444',
      resolutionSource: 'live-discovery',
      status: 'rebound',
      rebound: true,
    });

    expect(JSON.parse(output).targetResolution).toMatchObject({
      requestedTargetId: 'CCCCDDDD33334444',
      boundTargetId: 'AAAABBBB11112222',
      resolvedTargetId: 'CCCCDDDD33334444',
      status: 'rebound',
      rebound: true,
    });
  });

  it('treats a daemon bound to a different target as stale', () => {
    const assessment = T.assessDaemonFreshness({
      targetPrefix: 'CCCCDDDD',
      expectedTargetId: 'CCCCDDDD33334444',
      current: { schema: 'chrome-cdp-ex.daemon-metadata.v1', gitCommit: 'same' },
      daemon: {
        schema: 'chrome-cdp-ex.daemon-metadata.v1',
        gitCommit: 'same',
        boundTargetId: 'AAAABBBB11112222',
      },
    });
    expect(assessment).toMatchObject({ stale: true, status: 'target-mismatch' });
    expect(assessment.mismatches).toContainEqual(expect.objectContaining({ field: 'boundTargetId' }));
  });
});

describe('issue #141 perceive target/document readiness', () => {
  const persistentMismatchMessage = [
    'perceive: target/document readiness mismatch;',
    'targetId=ABC12345FULLTARGET;',
    'requestedTargetId=ABC12345FULLTARGET;',
    'resolvedTargetId=ABC12345FULLTARGET;',
    'boundTargetId=ABC12345FULLTARGET;',
    'advertisedUrl=https://example.test/start;',
    'observedUrl=about:srcdoc;',
    'readyState=interactive;',
    'attempts=3/3;',
    'elapsedMs=18.',
  ].join(' ');

  function createHandler({
    advertisedUrl = 'https://example.test/start',
    states = [{ url: 'https://example.test/start', readyState: 'complete' }],
    sampleDelaysMs = [0, 7, 11],
    metadataError = null,
  } = {}) {
    let stateIndex = 0;
    let clock = 500;
    const waits = [];
    const reads = [];
    const forbiddenCdp = {
      send(method) {
        throw new Error(`unexpected CDP command: ${method}`);
      },
    };
    const emptyBuffer = { all: () => [] };
    const handler = T.createPerceiveCommandHandler({
      cdp: forbiddenCdp,
      sessionId: 'session-141',
      targetId: 'ABC12345FULLTARGET',
      session: { lastAction: null },
      consoleBuf: emptyBuffer,
      exceptionBuf: emptyBuffer,
      netReqBuf: emptyBuffer,
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: { generation: 0 },
      ops: {
        readPerceiveTargetMetadata: async () => {
          if (metadataError) throw metadataError;
          return {
            targetId: 'ABC12345FULLTARGET',
            url: advertisedUrl,
          };
        },
        readPerceiveDocumentState: async () => {
          const state = states[Math.min(stateIndex, states.length - 1)];
          stateIndex += 1;
          reads.push(state);
          return state;
        },
        perceiveReadinessDelaysMs: sampleDelaysMs,
        sleep: async ms => {
          waits.push(ms);
          clock += ms;
        },
        now: () => clock,
        pageInfoModel: async () => ({ title: 'Ready', url: states.at(-1)?.url || advertisedUrl }),
        collectPageHealth: async () => ({ status: 'healthy' }),
        perceiveText: async () => 'ready perception',
        perceiveModel: async () => ({
          schema: 'chrome-cdp-ex.perception.v1',
          page: { title: 'Ready', url: states.at(-1)?.url || advertisedUrl },
        }),
        perceiveDiffModel: async () => ({
          schema: 'chrome-cdp-ex.perceive-diff.v1',
          changed: false,
        }),
      },
    });
    return { handler, reads, waits };
  }

  it('boundedly samples a blank renderer and accepts a nonblank redirect without navigation', async () => {
    const fixture = createHandler({
      states: [
        { url: 'about:blank', readyState: 'loading' },
        { url: 'about:srcdoc', readyState: 'interactive' },
        { url: 'https://redirect.example.test/final', readyState: 'complete' },
      ],
    });

    const result = await fixture.handler({ args: [] });

    expect(result.value).toBe('ready perception');
    expect(fixture.reads).toEqual([
      { url: 'about:blank', readyState: 'loading' },
      { url: 'about:srcdoc', readyState: 'interactive' },
      { url: 'https://redirect.example.test/final', readyState: 'complete' },
    ]);
    expect(fixture.waits).toEqual([7, 11]);
    expect(result.value).not.toContain('Navigated');
  });

  it.each([
    ['text', []],
    ['JSON', ['--format', 'json']],
    ['QA JSON', ['--qa', '--format', 'json']],
  ])('fails %s perception explicitly when the advertised HTTP target stays blank', async (_label, args) => {
    const fixture = createHandler({
      states: [
        { url: 'about:blank', readyState: 'loading' },
        { url: 'about:blank', readyState: 'interactive' },
        { url: 'about:srcdoc', readyState: 'interactive' },
      ],
    });

    await expect(fixture.handler({ args })).rejects.toThrow(persistentMismatchMessage);
    expect(fixture.waits).toEqual([7, 11]);
  });

  it('formats a readiness mismatch as an executable perceive retry instead of a status loop', () => {
    const output = T.formatCliError(new Error(persistentMismatchMessage), {
      cmd: 'perceive',
      targetPrefix: 'ABC12345',
    });

    expect(output).toContain('Kind: loading');
    expect(output).toContain('Strategy: retry-perceive');
    expect(output).toContain('Run: cdp perceive ABC12345 -C -d 8');
    expect(output).toContain('Next: cdp perceive ABC12345 -C -d 8');
    expect(output).not.toContain('cdp status');
  });

  it('builds the same bounded perceive retry in the structured CLI error model', () => {
    const model = T.buildCliErrorModel(new Error(persistentMismatchMessage), {
      cmd: 'perceive',
      targetPrefix: 'ABC12345',
    });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.cli-error.v1',
      ok: false,
      command: 'perceive',
      targetPrefix: 'ABC12345',
      error: { message: persistentMismatchMessage },
      recovery: {
        kind: 'loading',
        strategy: 'retry-perceive',
        run: 'cdp perceive ABC12345 -C -d 8',
      },
      nextSteps: ['cdp perceive ABC12345 -C -d 8'],
    });
    expect(model.recovery.run).not.toContain('status');
  });

  it.each([
    ['intentionally blank', 'about:blank'],
    ['non-HTTP', 'file:///tmp/fixture.html'],
  ])('preserves current perception behavior for an %s advertised target', async (_label, advertisedUrl) => {
    const fixture = createHandler({
      advertisedUrl,
      states: [{ url: 'about:blank', readyState: 'complete' }],
    });

    await expect(fixture.handler({ args: [] })).resolves.toMatchObject({ value: 'ready perception' });
    expect(fixture.reads).toEqual([]);
    expect(fixture.waits).toEqual([]);
  });

  it('preserves current perception behavior when live target metadata is unavailable', async () => {
    const fixture = createHandler({
      metadataError: new Error('Target.getTargets unavailable'),
    });

    await expect(fixture.handler({ args: [] })).resolves.toMatchObject({ value: 'ready perception' });
    expect(fixture.reads).toEqual([]);
    expect(fixture.waits).toEqual([]);
  });

  it('stops retrying when a renderer-state probe fails and preserves its exact error', async () => {
    const failure = new Error('Runtime.evaluate target closed');
    const fixture = createHandler();
    fixture.handler = T.createPerceiveCommandHandler({
      cdp: { send: () => { throw new Error('unexpected direct CDP call'); } },
      sessionId: 'session-141',
      targetId: 'ABC12345FULLTARGET',
      session: { lastAction: null },
      consoleBuf: { all: () => [] },
      exceptionBuf: { all: () => [] },
      netReqBuf: { all: () => [] },
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: { generation: 0 },
      ops: {
        readPerceiveTargetMetadata: async () => ({
          targetId: 'ABC12345FULLTARGET',
          url: 'https://example.test/start',
        }),
        readPerceiveDocumentState: async () => { throw failure; },
        perceiveReadinessDelaysMs: [0, 7, 11],
        sleep: async () => { throw new Error('probe failure must stop retries'); },
        perceiveText: async () => 'must not perceive',
      },
    });

    await expect(fixture.handler({ args: [] })).rejects.toBe(failure);
  });
});

describe('issues #93-#95 contracts', () => {
  it('#93 builds emulate media-feature models and resets cleanly', () => {
    expect(T.parseEmulateArgs(['dark']).colorScheme).toBe('dark');
    expect(T.parseEmulateArgs(['reduced-motion', 'reduce']).reducedMotion).toBe('reduce');
    expect(T.parseEmulateArgs(['off']).mode).toBe('off');
    const features = T.buildEmulateFeatures({ colorScheme: 'dark', reducedMotion: 'reduce' });
    expect(features).toEqual(expect.arrayContaining([
      { name: 'prefers-color-scheme', value: 'dark' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ]));
    const model = T.buildEmulateModel({ colorScheme: 'dark', reducedMotion: null, features }, { targetPrefix: 'ABC12345' });
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.emulate.v1',
      active: true,
      colorScheme: 'dark',
      nextCommand: 'cdp perceive ABC12345 -C -d 8',
    });
    expect(T.formatEmulateText(model)).toContain('prefers-color-scheme: dark');
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({ name: 'emulate', needsTarget: true }));
  });

  it('#94 parses eval --raw and formats compact object output', () => {
    expect(T.parseEvalArgs(['--raw', '({a:1})'])).toMatchObject({ raw: true, expression: '({a:1})' });
    expect(T.formatEvalValue({ a: 1, b: 2 }, { raw: false })).toContain('\n');
    expect(T.formatEvalValue({ a: 1, b: 2 }, { raw: true })).toBe('{"a":1,"b":2}');
    expect(T.formatEvalValue(undefined, { raw: true })).toBe('');
  });
});

describe('issues #97-#101 contracts', () => {
  it('#97 stores tab groups and formats broadcast results', () => {
    let store = T.emptyTabGroupStore();
    store = T.upsertTabGroup(store, { name: 'auth', members: ['AAAABBBB', 'CCCCDDDD'] });
    expect(T.getTabGroup(store, 'auth').members).toEqual(['AAAABBBB', 'CCCCDDDD']);
    store = T.removeTabGroupMember(store, 'auth', 'CCCCDDDD');
    expect(T.getTabGroup(store, 'auth').members).toEqual(['AAAABBBB']);
    const model = T.buildBroadcastModel({
      groupName: 'auth',
      command: 'perceive',
      results: [
        { targetPrefix: 'AAAABBBB', ok: true, result: 'Page: A' },
        { targetPrefix: 'CCCCDDDD', ok: false, error: 'timeout' },
      ],
    });
    expect(model).toMatchObject({ schema: 'chrome-cdp-ex.broadcast.v1', ok: 1, failed: 1 });
    expect(T.formatBroadcastResult(model)).toContain('1/2 ok');
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({ name: 'tab-group' }));
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({ name: 'broadcast', mutates: true }));
  });

  it('#98 parses components args and detector script', () => {
    expect(T.parseComponentsArgs(['--depth', '3', '@2'])).toMatchObject({ depth: 3, ref: '@2' });
    expect(T.frameworkDetectorScript()).toContain('__REACT_DEVTOOLS_GLOBAL_HOOK__');
    expect(T.reactComponentsTreeScript(2)).toContain('maxDepth = 2');
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({ name: 'components', needsTarget: true }));
  });

  it('#99 chooses adaptive perceive last budgets from density and errors', () => {
    expect(T.chooseAdaptivePerceiveLast({ lineCount: 50, consoleErrors: 0, interactiveCount: 5 })).toBeGreaterThanOrEqual(40);
    expect(T.chooseAdaptivePerceiveLast({ lineCount: 500, consoleErrors: 0, interactiveCount: 10 })).toBeLessThanOrEqual(20);
    expect(T.chooseAdaptivePerceiveLast({ lineCount: 120, consoleErrors: 3, interactiveCount: 5 })).toBeGreaterThanOrEqual(28);
    expect(T.parsePerceiveArgs(['--adaptive']).adaptive).toBe(true);
    expect(T.parsePerceiveArgs(['--last', 'auto']).last).toBe('auto');
    expect(T.parsePerceiveArgs(['--last', '12']).last).toBe(12);
  });

  it('#100 and #101 ship docs artifacts for Browser Use mapping and outreach research', async () => {
    const { readFileSync, existsSync } = await import('fs');
    expect(existsSync('docs/browser-use-mapping.md')).toBe(true);
    expect(existsSync('docs/outreach/awesome-lists.md')).toBe(true);
    const mapping = readFileSync('docs/browser-use-mapping.md', 'utf8');
    expect(mapping).toMatch(/Action Receipt/i);
    expect(mapping).toMatch(/recovery/i);
    const outreach = readFileSync('docs/outreach/awesome-lists.md', 'utf8');
    expect(outreach).toMatch(/Do not auto-submit/i);
  });
});

describe('v2.11.0 review regressions', () => {
  it('preserves eval --raw through the top-level CLI argument normalizer', () => {
    expect(T.normalizeEvalCliArgs(['--raw', '({a:1})'])).toEqual(['--raw', '({a:1})']);
    expect(T.normalizeEvalCliArgs(['({a:1})', '--raw'])).toEqual(['--raw', '({a:1})']);
    expect(T.normalizeEvalCliArgs(['--fire-and-forget', '--raw', '({a:1})']))
      .toEqual(['--fire-and-forget', '--raw', '({a:1})']);
  });

  it('treats CSS pseudo-class component targets as selectors, not refs', () => {
    expect(T.parseComponentsArgs(['#root > button:first-child'])).toMatchObject({
      ref: null,
      selector: '#root > button:first-child',
    });
    expect(T.parseComponentsArgs(['@f2:3'])).toMatchObject({ ref: '@f2:3', selector: null });
    expect(() => T.parseComponentsArgs(['@scope'])).toThrow('components: invalid ref @scope');
  });

  it('resolves components @refs through the established object-id contract', async () => {
    let callFunctionOn = null;
    const calls = [];
    const cdp = {
      async send(method, params) {
        calls.push([method, params]);
        if (method === 'Runtime.evaluate') {
          return { result: { value: JSON.stringify({ framework: 'react', version: '18', source: 'test' }) } };
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root-frame' } } };
        if (method === 'Page.createIsolatedWorld') {
          expect(params).toMatchObject({
            frameId: 'root-frame',
            worldName: 'chrome-cdp-ex-ref-validation',
            grantUniveralAccess: false,
          });
          return { executionContextId: 901 };
        }
        if (method === 'DOM.resolveNode') {
          return { object: {
            objectId: params.executionContextId === 901
              ? 'isolated-component-node-1'
              : 'component-node-1',
          } };
        }
        if (method === 'Runtime.callFunctionOn') {
          if (params.functionDeclaration.includes('ownerDocumentGetter')) {
            expect(params.objectId).toBe('isolated-component-node-1');
            return { result: { value: { connected: true } } };
          }
          callFunctionOn = params;
          return { result: { value: JSON.stringify({
            ok: true,
            name: 'SecretPanel',
            props: { label: 'Inspect' },
            state: { hook0: false },
          }) } };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    };
    const output = JSON.parse(await T.componentsStr(
      cdp,
      'session-1',
      ['@1', '--format', 'json'],
      new Map([[1, 123]]),
      { generation: 1 },
    ));
    expect(callFunctionOn?.objectId).toBe('component-node-1');
    expect(callFunctionOn?.functionDeclaration).toMatch(/^function\s*\(/);
    expect(output).toMatchObject({ ok: true, name: 'SecretPanel', target: '@1' });
    expect(calls.filter(([method]) => method === 'DOM.resolveNode').map(([, params]) => params))
      .toEqual([
        { backendNodeId: 123, executionContextId: 901 },
        { backendNodeId: 123 },
      ]);
  });

  it('resolves cursor-interactive component refs to a live DOM object', async () => {
    let callFunctionOn = null;
    const cdp = {
      async send(method, params) {
        if (method === 'Runtime.evaluate' && params.expression.includes('__REACT_DEVTOOLS_GLOBAL_HOOK__')) {
          return { result: { value: JSON.stringify({ framework: 'react', version: '18', source: 'test' }) } };
        }
        if (method === 'Runtime.evaluate' && params.expression.includes('document.elementFromPoint')) {
          return { result: { objectId: 'cursor-component-node' } };
        }
        if (method === 'Runtime.callFunctionOn') {
          callFunctionOn = params;
          return { result: { value: JSON.stringify({ ok: true, name: 'CursorPanel', props: {}, state: {} }) } };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    };

    const output = JSON.parse(await T.componentsStr(
      cdp,
      'session-1',
      ['@c1', '--format', 'json'],
      new Map([['c1', { x: 10, y: 20, w: 80, h: 40, sel: '#cursor-panel' }]]),
      { generation: 1 },
    ));

    expect(callFunctionOn?.objectId).toBe('cursor-component-node');
    expect(output).toMatchObject({ ok: true, name: 'CursorPanel', target: '@c1' });
  });

  it('fails explicitly when targeted component state is unsupported for the detected framework', async () => {
    const cdp = {
      async send(method) {
        if (method === 'Runtime.evaluate') {
          return { result: { value: JSON.stringify({ framework: 'vue', version: '3.5', source: '__VUE__' }) } };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    };

    const output = JSON.parse(await T.componentsStr(
      cdp,
      'session-1',
      ['#account-panel', '--format', 'json'],
      new Map(),
      { generation: 1 },
    ));

    expect(output).toMatchObject({
      framework: 'vue',
      target: '#account-panel',
      ok: false,
      reason: 'target-inspection-unsupported',
    });
  });

  it('redacts and bounds component props and state by default', () => {
    const result = T.sanitizeComponentValue({
      password: 'hunter2',
      nested: { sessionToken: 'secret-session-token' },
      huge: 'x'.repeat(2000),
    }, { maxChars: 160 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('secret-session-token');
    expect(serialized).toContain('<redacted>');
    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBeGreaterThan(160);
    expect(result.value).toMatchObject({ truncated: true });
  });

  it('redacts nested secrets from React and Vue component tree previews', () => {
    function ProfileCard() {}
    const componentFiber = {
      type: ProfileCard,
      memoizedProps: { profile: { token: 'react-nested-secret', name: 'Ada' } },
      child: null,
      sibling: null,
      return: null,
    };
    const rootFiber = { type: null, child: componentFiber, sibling: null, return: null };
    componentFiber.return = rootFiber;
    const root = { '__reactFiber$test': rootFiber };
    const reactOutput = runInNewContext(T.reactComponentsTreeScript(2), {
      document: { querySelectorAll: () => [root] },
    });

    const vueInstance = {
      type: { name: 'ProfileCard' },
      props: { profile: { token: 'vue-nested-secret', name: 'Ada' } },
      subTree: { component: { subTree: { children: [] } } },
    };
    const vueOutput = runInNewContext(T.vueComponentsTreeScript(2), {
      document: {
        querySelector: selector => selector === '#app'
          ? { __vue_app__: { _instance: vueInstance } }
          : null,
      },
    });

    expect(reactOutput).not.toContain('react-nested-secret');
    expect(vueOutput).not.toContain('vue-nested-secret');
    expect(reactOutput).toContain('[REDACTED]');
    expect(vueOutput).toContain('[REDACTED]');
  });

  it('keeps broadcast retries executable and bounds default result payloads', () => {
    const resultText = `Filled input\n${'x'.repeat(2000)}`;
    const errorText = `timeout: ${'y'.repeat(2000)}`;
    const model = T.buildBroadcastModel({
      groupName: 'auth',
      command: 'fill',
      commandArgs: ['#cmd', 'hello world'],
      results: [
        { targetPrefix: 'AAAABBBB', ok: true, result: resultText },
        { targetPrefix: 'CCCCDDDD', ok: false, error: errorText },
      ],
    });
    expect(model.nextSteps[0]).toBe('cdp fill CCCCDDDD #cmd "hello world"');
    expect(model.results[0].result).toBeUndefined();
    expect(model.results[0].resultPreview.length).toBeLessThanOrEqual(240);
    expect(model.results[0].resultChars).toBe(resultText.length);
    expect(model.results[1].error).toBeUndefined();
    expect(model.results[1].errorPreview.length).toBeLessThanOrEqual(240);
    expect(model.results[1].errorChars).toBe(errorText.length);
    expect(model.results[1].errorTruncated).toBe(true);

    const full = T.buildBroadcastModel({
      groupName: 'auth',
      command: 'fill',
      commandArgs: ['#cmd', 'hello world'],
      results: [{ targetPrefix: 'AAAABBBB', ok: true, result: resultText }],
      fullResults: true,
    });
    expect(full.results[0].result).toBe(resultText);
  });

  it('makes an ambiguous broadcast mutation verify state instead of replaying it', () => {
    const transport = {
      completion: 'unknown',
      sideEffectMayHaveOccurred: true,
      retrySafe: false,
      transportCause: {
        phase: 'awaiting-response',
        kind: 'peer-close',
        message: 'Connection closed before response.',
      },
    };
    const model = T.buildBroadcastModel({
      groupName: 'checkout',
      command: 'click',
      commandArgs: ['#purchase'],
      results: [{
        target: 'buyer',
        targetPrefix: 'AAAABBBB',
        ok: false,
        error: 'The action may have taken effect.',
        ...transport,
      }],
    });

    expect(model.results[0]).toMatchObject(transport);
    expect(model.nextSteps).toEqual(['cdp perceive AAAABBBB -C -d 8']);
    expect(model.nextSteps.join('\n')).not.toContain('#purchase');
  });

  it('maps low-token defaults through the MCP adapter', () => {
    expect(buildMcpToolCommand('perceive', { target: 'AAAABBBB' }))
      .toEqual(expect.arrayContaining(['--adaptive']));
    expect(buildMcpToolCommand('controls', { target: 'AAAABBBB' }))
      .toEqual(expect.arrayContaining(['--compact']));
    expect(buildMcpToolCommand('report', { target: 'AAAABBBB', last: 5 }))
      .toEqual(expect.arrayContaining(['--compact']));

    const perceive = MCP_TOOL_DEFINITIONS.find(tool => tool.name === 'perceive');
    const controls = MCP_TOOL_DEFINITIONS.find(tool => tool.name === 'controls');
    const report = MCP_TOOL_DEFINITIONS.find(tool => tool.name === 'report');
    expect(perceive.inputSchema.properties).toHaveProperty('adaptive');
    expect(controls.inputSchema.properties).toHaveProperty('compact');
    expect(report.inputSchema.properties).toHaveProperty('compact');
  });

  it('registers key/resize/tabs aliases and suggests near-miss unknown commands (#126/#129)', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'press',
      aliases: expect.arrayContaining(['key']),
    }));
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'viewport',
      aliases: expect.arrayContaining(['resize']),
    }));
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'list',
      aliases: expect.arrayContaining(['tabs', 'ls']),
    }));
    expect(T.NEEDS_TARGET.has('key')).toBe(true);
    expect(T.NEEDS_TARGET.has('resize')).toBe(true);
    expect(T.NEEDS_TARGET.has('tabs')).toBe(false);

    expect(T.suggestCommands('resize')).toEqual(['viewport']);
    expect(T.suggestCommands('tabs')).toEqual(['list']);
    expect(T.suggestCommands('tabgroup')).toEqual(['tab-group']);
    expect(T.suggestCommands('key')).toEqual(['press']);

    const text = T.formatCliError(new Error('Unknown command: resize'), { cmd: 'resize' });
    expect(text).toContain('Did you mean: viewport?');
    expect(text).toContain('Strategy: suggest-command');
    expect(text).toContain('Run: cdp viewport');
    expect(text).not.toMatch(/Usage: cdp <command>/);
  });

  it('classifies Playwright :has-text selectors as invalid-selector usage (#127)', () => {
    const failure = T.classifyActionFailure(
      new Error(`SyntaxError: Failed to execute 'querySelector' on 'Document': ':has-text("往北")' is not a valid selector.`),
      { action: 'click', target: { targetId: 'AAAABBBB', input: ':has-text("往北")' } },
    );
    expect(failure).toMatchObject({
      kind: 'invalid-selector',
    });
    expect(failure.reason.toLowerCase()).toMatch(/playwright|valid selector|css/);
    expect(failure.hints.join(' ')).toMatch(/data-testid|@ref|css/i);
    expect(failure.hints.join(' ')).not.toMatch(/click --text/);
    // Prefer corrected usage over a full re-perceive as the primary next step.
    expect(failure.nextCommand).not.toBe('cdp perceive AAAABBBB -C -d 8');

    const text = T.formatActionFailure(
      new Error(`SyntaxError: Failed to execute 'querySelector' on 'Document': ':has-text("north")' is not a valid selector.`),
      { action: 'click', target: { targetId: 'AAAABBBB', input: ':has-text("north")' } },
    );
    expect(text).toContain('Action failure: invalid-selector');
    expect(text).not.toContain('Action failure: unknown');
  });

  it('omits overflow-scrollport-clipped controls from default interactive inventory (#128)', () => {
    const source = T.visibleControlsCollectorSource();
    expect(source).toMatch(/nearestScrollable|scrollport|overflow/);
    expect(source).toMatch(/clipped/);

    const clippedButton = {
      tagName: 'BUTTON',
      id: 'exit-south',
      className: 'exit',
      disabled: false,
      tabIndex: 0,
      innerText: '往南',
      textContent: '往南',
      parentElement: null,
      getAttribute: (name) => ({ role: null, 'aria-label': null, title: null, type: null }[name] ?? null),
      hasAttribute: () => false,
      getBoundingClientRect: () => ({ left: 10, top: 381, right: 90, bottom: 434, width: 80, height: 53 }),
      matches: (selector) => selector.includes('button'),
      querySelectorAll: () => [],
    };
    const scrollport = {
      tagName: 'DIV',
      id: 'panel',
      parentElement: { parentElement: null },
      scrollWidth: 300,
      clientWidth: 300,
      scrollHeight: 452,
      clientHeight: 256,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 92, right: 300, bottom: 348, width: 300, height: 256 }),
    };
    clippedButton.parentElement = scrollport;

    const sandbox = {
      window: {
        innerWidth: 390,
        innerHeight: 844,
        CSS: { escape: (value) => String(value) },
        getComputedStyle: (el) => {
          if (el === scrollport) {
            return { display: 'block', visibility: 'visible', opacity: '1', cursor: 'default', overflowX: 'hidden', overflowY: 'auto' };
          }
          return { display: 'block', visibility: 'visible', opacity: '1', cursor: 'pointer', overflowX: 'visible', overflowY: 'visible' };
        },
      },
      document: {
        documentElement: {},
        body: {},
        querySelector: (selector) => (selector === '#exit-south' ? clippedButton : null),
      },
      CSS: { escape: (value) => String(value) },
    };
    sandbox.window.document = sandbox.document;
    const script = T.visibleControlsPageScript({ selector: '#exit-south', limit: 5 });
    const model = JSON.parse(runInNewContext(script, sandbox));
    expect(model.controls).toEqual([]);
    expect(model.total).toBe(0);
  });

  it('keys daemon git identity off the script package root, not process.cwd (#130)', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-daemon-meta-'));
    const skillScripts = path.join(tmp, 'skills', 'chrome-cdp-ex', 'scripts');
    fs.mkdirSync(skillScripts, { recursive: true });
    const scriptPath = path.join(skillScripts, 'cdp.mjs');
    fs.writeFileSync(scriptPath, '// fixture\n');
    const packageJsonPath = path.join(tmp, 'package.json');
    fs.writeFileSync(packageJsonPath, JSON.stringify({ name: 'pi-chrome-cdp', version: '9.9.9' }));
    const linkDir = path.join(tmp, 'skill-link');
    fs.mkdirSync(linkDir, { recursive: true });
    const linkedScript = path.join(linkDir, 'cdp.mjs');
    fs.symlinkSync(scriptPath, linkedScript);

    const otherCwd = path.join(tmp, 'other-checkout');
    fs.mkdirSync(otherCwd, { recursive: true });
    const previousCwd = process.cwd();
    try {
      process.chdir(otherCwd);
      const metaFromLink = T.collectDaemonMetadata({ scriptPath: linkedScript, now: Date.UTC(2026, 6, 24, 12), pid: 42 });
      expect(fs.realpathSync(metaFromLink.scriptPath)).toBe(fs.realpathSync(scriptPath));
      expect(metaFromLink.packageVersion).toBe('9.9.9');

      const orphanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-daemon-orphan-'));
      const orphanScript = path.join(orphanRoot, 'orphan.mjs');
      fs.writeFileSync(orphanScript, '// orphan\n');
      try {
        const metaWithoutPackage = T.collectDaemonMetadata({
          scriptPath: orphanScript,
          now: Date.UTC(2026, 6, 24, 12),
          pid: 43,
        });
        expect(metaWithoutPackage.gitCommit).toBeNull();
        expect(metaWithoutPackage.packageVersion).toBeNull();
      } finally {
        fs.rmSync(orphanRoot, { recursive: true, force: true });
      }
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#155 persists last-known debug browser identity after spawn-debug-browser succeeds', async () => {
    const remembered = [];
    const fs = {
      existsSync: path => path === '/opt/chromium/chrome',
      mkdirSync: () => {},
    };
    const child = {
      pid: 4242,
      unref: () => {},
      stdout: { on: () => {}, setEncoding: () => {}, unref: () => {} },
      stderr: { on: () => {}, setEncoding: () => {}, unref: () => {} },
      on: () => {},
      once: () => {},
    };

    await T.spawnDebugBrowserStr([
      'chrome',
      '--port', '9224',
      '--user-data-dir', '/tmp/real-x-profile',
      '--exe', '/opt/chromium/chrome',
    ], { TMPDIR: '/tmp', PATH: '' }, {
      platform: 'linux',
      fs,
      spawn: () => child,
      probeTcpPort: async () => ({ occupied: false }),
      waitForSpawnedCdp: async ({ port }) => ({ ok: true, port, product: 'Chrome/126.0.0.0' }),
      rememberLastCdpEndpoint: record => remembered.push(record),
    });

    expect(remembered).toEqual([expect.objectContaining({
      host: '127.0.0.1',
      port: 9224,
      profileDir: '/tmp/real-x-profile',
      exe: '/opt/chromium/chrome',
      browser: 'chrome',
    })]);
  });

  it('#155 round-trips last endpoint JSON without secrets', () => {
    const files = new Map();
    const runtimeDir = '/tmp/cdp-runtime-155';
    T.writeLastCdpEndpoint({
      host: '127.0.0.1',
      port: 9224,
      profileDir: '/tmp/real-x-profile',
      exe: '/opt/chromium/chrome',
      browser: 'chrome',
      launchedAt: '2026-08-14T09:00:00.000Z',
    }, {
      runtimeDir,
      writer: (path, data) => files.set(path, String(data)),
    });

    const stored = JSON.parse(files.get(`${runtimeDir}/cdp-last-endpoint.json`));
    expect(stored).toEqual({
      schema: 'chrome-cdp-ex.cdp-last-endpoint.v1',
      host: '127.0.0.1',
      port: '9224',
      profileDir: '/tmp/real-x-profile',
      exe: '/opt/chromium/chrome',
      browser: 'chrome',
      launchedAt: '2026-08-14T09:00:00.000Z',
    });
    expect(JSON.stringify(stored)).not.toMatch(/cookie|password|token|secret/i);

    const read = T.readLastCdpEndpoint({
      runtimeDir,
      reader: path => {
        if (!files.has(path)) throw new Error('ENOENT');
        return files.get(path);
      },
    });
    expect(read.profileDir).toBe('/tmp/real-x-profile');
    expect(read.port).toBe('9224');
  });

  it('#155 skips WebSocket fallback on ECONNREFUSED and relaunches the same profile', async () => {
    let wsCalls = 0;
    const lastEndpoint = {
      host: '127.0.0.1',
      port: '9224',
      profileDir: '/tmp/real-x-profile',
      exe: '/opt/chromium/chrome',
      browser: 'chrome',
    };
    const started = Date.now();
    const r = await T.checkCdpReachability({
      env: { CDP_PORT: '9224' },
      fetcher: async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:9224');
        err.code = 'ECONNREFUSED';
        throw err;
      },
      lastEndpoint,
      connectWebSocket: () => {
        wsCalls += 1;
        throw new Error('WebSocket fallback should not run after connection refused');
      },
    });

    expect(Date.now() - started).toBeLessThan(500);
    expect(wsCalls).toBe(0);
    expect(r).toMatchObject({
      status: 'FAIL',
      label: 'CDP',
      error: 'cdp_unreachable',
      host: '127.0.0.1',
      port: '9224',
      profileDir: '/tmp/real-x-profile',
    });
    expect(r.relaunch).toBe('/opt/chromium/chrome --remote-debugging-port=9224 --user-data-dir /tmp/real-x-profile');
    expect(r.relaunch).not.toMatch(/spawn-debug-browser|rm -rf|disposable/i);
    expect(r.hint).toBe(r.relaunch);
    expect(r.detail).toMatch(/cannot reach 127\.0\.0\.1:9224/i);
  });

  it('#155 still uses WebSocket fallback when /json/version returns 404', async () => {
    let wsCalls = 0;
    const r = await T.checkCdpReachability({
      env: { CDP_PORT: '9224' },
      fetcher: async () => ({ ok: false, status: 404 }),
      connectWebSocket: async () => {
        wsCalls += 1;
        return true;
      },
    });
    expect(wsCalls).toBe(1);
    expect(r.status).toBe('OK');
    expect(r.detail).toMatch(/WebSocket fallback/i);
  });

  it('#155 CLI error model reports cdp_unreachable with the remembered profile relaunch', () => {
    const err = T.cdpUnreachableError({
      host: '127.0.0.1',
      port: '9224',
      cause: 'connect ECONNREFUSED',
      lastEndpoint: {
        host: '127.0.0.1',
        port: '9224',
        profileDir: '/tmp/real-x-profile',
        browser: 'chrome',
        exe: '/opt/chromium/chrome',
      },
    });
    const model = T.buildCliErrorModel(err, { cmd: 'list' });
    const text = T.formatCliError(err, { cmd: 'list' });

    expect(err.code).toBe('cdp_unreachable');
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.cli-error.v1',
      ok: false,
      command: 'list',
      error: {
        code: 'cdp_unreachable',
        message: expect.stringMatching(/cannot reach cdp on 127\.0\.0\.1:9224/i),
      },
      host: '127.0.0.1',
      port: '9224',
      profileDir: '/tmp/real-x-profile',
      relaunch: expect.stringContaining('--user-data-dir /tmp/real-x-profile'),
    });
    expect(model.recovery).toMatchObject({
      kind: 'browser-cdp',
      strategy: 'relaunch-same-profile',
      run: model.relaunch,
    });
    expect(text).toContain(model.relaunch);
    expect(text).not.toMatch(/chrome-profile-2|DISPLAY=:2/);
  });

  it('#155 unknown profile tells the agent not to invent a new user-data-dir', () => {
    const err = T.cdpUnreachableError({
      host: '127.0.0.1',
      port: '9224',
      cause: 'connect ECONNREFUSED',
      lastEndpoint: null,
    });
    const model = T.buildCliErrorModel(err, { cmd: 'attach' });
    expect(model.ok).toBe(false);
    expect(model.error.code).toBe('cdp_unreachable');
    expect(model.profileDir).toBeNull();
    expect(model.relaunch).toBeNull();
    expect(model.error.message).toMatch(/do not invent a new --user-data-dir/i);
    expect(model.error.message).toMatch(/chrome:\/\/inspect\/#remote-debugging/);
    expect(model.recovery.strategy).toBe('enable-existing-debugging');
  });

  it('#155 doctor FAIL hint and recommendation reuse the remembered profile', async () => {
    const lastEndpoint = {
      host: '127.0.0.1',
      port: '9224',
      profileDir: '/tmp/real-x-profile',
      exe: '/opt/chromium/chrome',
      browser: 'chrome',
    };
    const fetcher = async () => {
      const err = new Error('connect ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      throw err;
    };
    const checks = await T.runDoctorChecks({
      nodeVersion: 'v22.10.0',
      home: '/tmp/x',
      fs: { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => true }) },
      listDaemons: () => [],
      fdLimit: 4096,
      platform: 'darwin',
      env: { CDP_PORT: '9224' },
      fetcher,
      lastEndpoint,
      connectWebSocket: () => {
        throw new Error('WebSocket fallback should not run');
      },
    });
    const model = T.buildDoctorModel(checks);
    const cdp = model.checks.find(check => check.label === 'CDP');
    const relaunch = '/opt/chromium/chrome --remote-debugging-port=9224 --user-data-dir /tmp/real-x-profile';

    expect(cdp).toMatchObject({
      status: 'FAIL',
      error: 'cdp_unreachable',
      profileDir: '/tmp/real-x-profile',
      hint: relaunch,
      relaunch,
    });
    expect(model.recommendation).toMatchObject({
      stage: 'browser-cdp',
      run: relaunch,
      strategy: 'relaunch-same-profile',
    });
    expect(model.nextSteps[0]).toBe(relaunch);

    const text = T.formatDoctorOutput(checks);
    expect(text).toContain(`hint: ${relaunch}`);
    expect(text).not.toMatch(/spawn-debug-browser|rm -rf|Profile is disposable/);
  });

  it('#155 doctor with CDP_PORT and unknown profile on Linux/no DISPLAY does not spawn a blank profile', async () => {
    const fs = {
      existsSync: path => path === '/usr/bin/chromium' || path.endsWith('package.json'),
      lstatSync: () => ({ isDirectory: () => false, isSymbolicLink: () => false }),
    };
    const checks = await T.runDoctorChecks({
      nodeVersion: 'v22.1.0',
      platform: 'linux',
      fdLimit: 4096,
      home: '/home/agent',
      env: { PATH: '/usr/bin', CDP_PORT: '9224', CI: 'true' },
      fs,
      fetcher: async () => {
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        throw err;
      },
      listDaemons: () => [],
      lastEndpoint: null,
      connectWebSocket: () => {
        throw new Error('WebSocket fallback should not run');
      },
    });
    const model = T.buildDoctorModel(checks);
    const text = T.formatDoctorOutput(checks);

    expect(checks.find(check => check.label === 'Environment')?.status).toBe('WARN');
    expect(model.recommendation).toMatchObject({
      stage: 'browser-cdp',
      strategy: 'enable-existing-debugging',
      run: null,
    });
    expect(model.recommendation.ask).toMatch(/chrome:\/\/inspect\/#remote-debugging/);
    expect(JSON.stringify(model.recommendation)).not.toMatch(/spawn-debug-browser/);
    expect(model.nextSteps.join('\n')).not.toMatch(/spawn-debug-browser/);
    expect(text).not.toMatch(/spawn-debug-browser/);
    expect(text).toMatch(/chrome:\/\/inspect\/#remote-debugging/);
    expect(text).toMatch(/do not invent a new --user-data-dir/i);
  });

  it('#155 same-profile relaunch reuses an existing Chrome profile without disposable spawn cleanup', () => {
    const lastEndpoint = {
      host: '127.0.0.1',
      port: '9224',
      profileDir: '/Users/me/Library/Application Support/Google/Chrome',
      exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      browser: 'chrome',
    };
    const relaunch = T.formatCdpRelaunchCommand(lastEndpoint, { port: '9224' });
    expect(relaunch).toContain('--remote-debugging-port=9224');
    expect(relaunch).toContain('--user-data-dir');
    expect(relaunch).toContain('/Users/me/Library/Application Support/Google/Chrome');
    expect(relaunch).not.toMatch(/spawn-debug-browser/);
    expect(relaunch).not.toMatch(/rm -rf/);
    expect(relaunch).not.toMatch(/disposable/i);

    const err = T.cdpUnreachableError({
      host: '127.0.0.1',
      port: '9224',
      cause: 'ECONNREFUSED',
      lastEndpoint,
    });
    const text = T.formatCliError(err, { cmd: 'list' });
    expect(text).toContain(relaunch);
    expect(text).not.toMatch(/rm -rf|Profile is disposable/);

    const model = T.buildSpawnDebugBrowserModel({
      browser: 'chrome',
      profileDir: lastEndpoint.profileDir,
      host: '127.0.0.1',
      port: 9224,
      url: null,
      exe: lastEndpoint.exe,
    }, { ok: true, product: 'Chrome' }, { child: { pid: 1 } });
    expect(model.cleanup.deleteProfile).toBeNull();
    const spawned = T.formatSpawnDebugBrowserOutput(model);
    expect(spawned).not.toMatch(/rm -rf/);
    expect(spawned).not.toMatch(/Profile is disposable/);
    expect(spawned).toMatch(/existing profile|reuse this profile/i);
  });

  it('#155 disposable tmp spawn profile still uses spawn-debug-browser cleanup', () => {
    const profileDir = '/tmp/chrome-cdp-ex-chrome-debug-profile-9224';
    const relaunch = T.formatCdpRelaunchCommand({
      port: '9224',
      profileDir,
      browser: 'chrome',
    });
    expect(relaunch).toBe('cdp spawn-debug-browser chrome --port 9224 --user-data-dir /tmp/chrome-cdp-ex-chrome-debug-profile-9224');
    const model = T.buildSpawnDebugBrowserModel({
      browser: 'chrome',
      profileDir,
      host: '127.0.0.1',
      port: 9224,
      url: null,
    }, { ok: true }, { child: { pid: 1 } });
    expect(model.cleanup.deleteProfile).toBe(`rm -rf ${profileDir}`);
    expect(T.formatSpawnDebugBrowserOutput(model)).toContain('Profile is disposable');
  });

  it('#155 rememberLastCdpEndpoint drops profileDir when the port changes without a new profile', () => {
    const files = new Map();
    const runtimeDir = '/tmp/cdp-runtime-155-port-change';
    const io = {
      runtimeDir,
      writer: (path, data) => files.set(path, String(data)),
      reader: path => {
        if (!files.has(path)) throw new Error('ENOENT');
        return files.get(path);
      },
    };
    T.writeLastCdpEndpoint({
      host: '127.0.0.1',
      port: 9224,
      profileDir: '/Users/me/Library/Application Support/Google/Chrome',
      browser: 'chrome',
    }, io);
    const next = T.rememberLastCdpEndpoint({
      host: '127.0.0.1',
      port: 9333,
    }, io);
    expect(next.port).toBe('9333');
    expect(next.profileDir).toBeNull();
    expect(T.readLastCdpEndpoint(io).profileDir).toBeNull();
  });

  it('#155 live CDP success on a new port does not keep the previous profileDir', async () => {
    const files = new Map();
    const runtimeDir = '/tmp/cdp-runtime-155-live-port-change';
    const io = {
      runtimeDir,
      writer: (path, data) => files.set(path, String(data)),
      reader: path => {
        if (!files.has(path)) throw new Error('ENOENT');
        return files.get(path);
      },
    };
    T.writeLastCdpEndpoint({
      host: '127.0.0.1',
      port: 9224,
      profileDir: '/Users/me/Library/Application Support/Google/Chrome',
      browser: 'chrome',
    }, io);
    const remembered = T.readLastCdpEndpoint(io);
    const result = await T.checkCdpReachability({
      env: { CDP_PORT: '9333' },
      lastEndpoint: remembered,
      rememberEndpoint: record => T.rememberLastCdpEndpoint(record, io),
      fetcher: async () => ({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser', Browser: 'Chrome/126' }),
      }),
    });
    expect(result.status).toBe('OK');
    expect(T.readLastCdpEndpoint(io).port).toBe('9333');
    expect(T.readLastCdpEndpoint(io).profileDir).toBeNull();
  });

  it('#155 dead-CDP doctor commands use the discovered Node 22 binary', async () => {
    const hermesNode = '/opt/hermes/node/bin/node';
    const cdpScript = '/repo/skills/chrome-cdp-ex/scripts/cdp.mjs';
    const checks = await T.runDoctorChecks({
      nodeVersion: 'v20.19.2',
      cdpScriptPath: cdpScript,
      discoverNode22: () => ({ binary: hermesNode, version: 'v22.14.0' }),
      home: '/tmp/x',
      fs: { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => true }) },
      listDaemons: () => [],
      fdLimit: 4096,
      platform: 'linux',
      env: { CDP_PORT: '9224' },
      fetcher: async () => {
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        throw err;
      },
      lastEndpoint: { host: '127.0.0.1', port: '9224' },
      connectWebSocket: () => {
        throw new Error('WebSocket fallback should not run');
      },
    });
    const model = T.buildDoctorModel(checks);
    const prefix = `${hermesNode} ${cdpScript}`;
    expect(model.recommendation.after).toBe(`${prefix} list`);
    expect(model.recommendation.ask).toContain(`${prefix} doctor`);
    expect(T.doctorNextSteps(checks).join('\n')).toContain(`${prefix} doctor`);
    expect(T.doctorNextSteps(checks).join('\n')).toContain(`${prefix} list`);
  });

  it('#155 getWsUrl throws a fail-fast cdp_unreachable error with the same-profile relaunch', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const err = new Error('connect ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      throw err;
    };
    try {
      await expect(T.getWsUrl({
        env: { CDP_PORT: '9224', CDP_HOST: '127.0.0.1' },
        lastEndpoint: {
          host: '127.0.0.1',
          port: '9224',
          profileDir: '/tmp/real-x-profile',
          browser: 'chrome',
        },
      })).rejects.toMatchObject({
        code: 'cdp_unreachable',
        port: '9224',
        profileDir: '/tmp/real-x-profile',
        relaunch: expect.stringContaining('--user-data-dir /tmp/real-x-profile'),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('#161 keeps main under exclude wrappers and points agents at text --auto', () => {
    const axNode = (id, role, opts = {}) => ({
      nodeId: id,
      role: { value: role },
      name: { value: opts.name || role },
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.backendDOMNodeId ? { backendDOMNodeId: opts.backendDOMNodeId } : {}),
    });
    const header = {
      nodeName: 'HEADER',
      backendNodeId: 1,
      children: [
        { nodeName: 'NAV', backendNodeId: 2, children: [] },
        { nodeName: 'MAIN', backendNodeId: 3, children: [{ nodeName: 'H1', backendNodeId: 4, children: [] }] },
      ],
    };
    const nodes = [
      axNode('root', 'WebArea'),
      axNode('header', 'banner', { parentId: 'root', backendDOMNodeId: 1 }),
      axNode('nav', 'navigation', { parentId: 'header', backendDOMNodeId: 2 }),
      axNode('main', 'main', { parentId: 'header', backendDOMNodeId: 3, name: 'Docs' }),
      axNode('h1', 'heading', { parentId: 'main', backendDOMNodeId: 4, name: 'Install' }),
    ];
    const filtered = T.filterPerceiveExcludedAxNodes(
      nodes,
      new Set([1, 2]),
      new Map([[1, header], [2, header.children[0]]]),
    );
    expect(filtered.map(n => n.nodeId)).toEqual(['root', 'header', 'main', 'h1']);

    const usage = T.helpStr();
    expect(usage).toContain('--auto');
    expect(usage).toMatch(/-x <sel> \/ --exclude/);
    expect(T.perceiveInteractiveNoiseHint(51)).toMatch(/text --auto/);
    expect(T.perceiveInteractiveNoiseHint(51)).toMatch(/must not empty main/);
  });

  it('#154 treats a Hermes-only skill path as a first-class install', () => {
    const home = '/home/test';
    const hermesPath = `${home}/.hermes/skills/chrome-cdp-ex`;
    const fs = {
      existsSync: path => path === hermesPath || path === `${hermesPath}/bin/chrome-cdp`,
      lstatSync: () => ({ isSymbolicLink: () => false }),
    };
    const result = T.checkSkillSymlink({ home, fs });
    expect(result.status).toBe('OK');
    expect(result.detail).toContain(hermesPath);
    expect(result.detail).not.toMatch(/not found/);
  });

  it('#154 hints ~/.hermes/skills when no host skill path exists', () => {
    const result = T.checkSkillSymlink({
      home: '/home/test',
      fs: { existsSync: () => false },
    });
    expect(result.status).toBe('WARN');
    expect(result.hint).toContain('~/.hermes/skills');
  });
});

describe('issue #158 unknown perceive flags', () => {
  it('#158 rejects unknown perceive flags with compact-flag help instead of dumping the page', async () => {
    expect(() => T.parsePerceiveArgs(['--cards'])).not.toThrow();
    expect(T.parsePerceiveArgs(['--cards']).cards).toBe(true);
    expect(() => T.parsePerceiveArgs(['--not-a-real-flag'])).toThrow(/unknown option --not-a-real-flag/);

    let message = '';
    try {
      T.parsePerceiveArgs(['--not-a-real-flag']);
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('unknown option --not-a-real-flag');
    expect(message).toContain('perceive compact flags:');
    expect(message).toContain('--last N | --adaptive | --qa | --summary | -i | -C | -d N | -x sel | -s sel');
    expect(message).toContain('--cards');

    const cli = T.formatCliError(new Error(message), { cmd: 'perceive', targetPrefix: 'F8741D08' });
    expect(cli).toContain('unknown option --not-a-real-flag');
    expect(cli).toContain('perceive compact flags:');
    expect(cli).not.toMatch(/Page:/);

    const handler = T.createPerceiveCommandHandler({
      cdp: { send() { throw new Error('unexpected CDP'); } },
      sessionId: 'session-158',
      targetId: 'F8741D08FULLTARGET',
      session: { lastAction: null },
      consoleBuf: { all: () => [] },
      exceptionBuf: { all: () => [] },
      netReqBuf: { all: () => [] },
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: { generation: 0 },
      ops: {
        readPerceiveTargetMetadata: async () => {
          throw new Error('should not sample readiness for unknown flags');
        },
        perceiveText: async () => 'FULL DUMP SHOULD NOT RUN',
      },
    });
    await expect(handler({ args: ['--feed-dump'] })).rejects.toThrow(/unknown option --feed-dump/);
    await expect(handler({ args: ['--qa', '--not-a-real-flag'] })).rejects.toThrow(/unknown option --not-a-real-flag/);

    const qa = T.parseQaModeArgs(['--qa', '--summary', '--adaptive']);
    expect(qa).toMatchObject({ qa: true, summary: true });
    expect(T.parsePerceiveArgs(qa.args).adaptive).toBe(true);
  });
});

describe('issue #144 pending CDP lifecycle errors', () => {
  it('does not recommend Allow debugging for websocket close or Inspector.detached', () => {
    const closed = T.formatCliError(
      new Error('CDP websocket closed while waiting for Page.navigate (code=1006, reason=going away)'),
      { cmd: 'nav', targetPrefix: 'AABBCCDD' }
    );
    const detached = T.formatCliError(
      new Error('CDP Inspector.detached while waiting for Page.navigate (reason=target_closed)'),
      { cmd: 'nav', targetPrefix: 'AABBCCDD' }
    );
    for (const out of [closed, detached]) {
      expect(out).not.toMatch(/click Allow/i);
      expect(out).not.toMatch(/Allow debugging/i);
    }
    const detachedModel = T.buildCliErrorModel(
      new Error('CDP Inspector.detached while waiting for Page.navigate (reason=target_closed)'),
      { cmd: 'nav', targetPrefix: 'AABBCCDD' }
    );
    expect(detachedModel.recovery.kind).toBe('target-closed');
    expect(detachedModel.recovery.run).toBe('cdp list');
  });

  it('completes real-document nav when Page.navigate hangs but the same target URL advanced', async () => {
    const calls = [];
    const cdp = {
      send(method, params = {}, sessionId) {
        calls.push({ method, params, sessionId });
        if (method === 'Page.navigate') return new Promise(() => {});
        if (method === 'Target.getTargets') {
          return Promise.resolve({
            targetInfos: [{
              targetId: '156B9713E3E6234E63401429592707D6',
              type: 'page',
              url: 'https://example.org/',
            }],
          });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: 'complete' } });
        }
        return Promise.resolve({});
      },
      waitForEvent() {
        return {
          promise: new Promise(() => {}),
          cancel() {},
        };
      },
    };

    const started = Date.now();
    await expect(T.navStr(cdp, 'sid1', 'https://example.org/', {
      targetId: '156B9713E3E6234E63401429592707D6',
      observeDelayMs: 0,
    })).resolves.toBe('Navigated to https://example.org/');
    expect(Date.now() - started).toBeLessThan(300);
    expect(calls.some(call => call.method === 'Target.getTargets' && call.sessionId == null)).toBe(true);
    expect(calls.some(call => call.method === 'Target.attachToTarget')).toBe(false);
  });

  it('daemon nav passes the bound targetId into navStr', () => {
    const source = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/navStr\(cdp, sessionId, url, \{[^}]*targetId/);
  });
});

describe('issue #160 open token budget', () => {
  it('defaults open to fail-fast attach without auto-perceive', () => {
    expect(T.DEFAULT_OPEN_ATTACH_TIMEOUT_MS).toBe(5000);
    expect(T.parseOpenArgs(['https://example.com'])).toMatchObject({
      attachTimeoutMs: 5000,
      perceive: false,
    });
    expect(T.parseOpenArgs(['https://example.com', '--perceive']).perceive).toBe(true);
    expect(T.parseOpenArgs(['https://example.com', '--attach-timeout-ms', '0']).attachTimeoutMs).toBe(0);
    expect(T.formatOpenNextPerceiveCommand('AABBCCDDEEFF')).toBe('Next: cdp text AABBCCDD --auto');
    expect(T.shouldAnnounceOpenAttachWait({ failedConnects: 1, elapsedMs: 300 })).toBe(false);
    expect(T.COMMANDS.find(command => command.name === 'open').feedbackPolicy).toBe('report-only');
  });
});

describe('issue #157 Node 22 discovery', () => {
  const hermesBinary = '/home/box/.hermes/node/bin/node';
  const cdpScriptPath = '/repo/skills/chrome-cdp-ex/scripts/cdp.mjs';
  const isolatedFs = {
    existsSync: () => false,
    readdirSync: () => [],
    readFileSync: () => '',
  };
  const isolatedSpawn = () => ({ status: 1, stdout: '' });

  function hermesDiscoverOpts(extra = {}) {
    return {
      home: '/home/box',
      env: {},
      execPath: '/usr/bin/node',
      cdpScriptPath,
      fs: {
        existsSync: path => path === hermesBinary,
        readdirSync: () => [],
        readFileSync: () => '',
      },
      spawnSync: (bin) => {
        if (bin === hermesBinary) return { status: 0, stdout: 'v22.23.2\n' };
        return { status: 1, stdout: '' };
      },
      ...extra,
    };
  }

  it('discovers Hermes Node 22 when PATH runtime is v20', () => {
    const found = T.discoverNode22(hermesDiscoverOpts());
    expect(found).toMatchObject({
      binary: hermesBinary,
      version: 'v22.23.2',
    });
  });

  it('checkNode with v20 + Hermes Node 22 is WARN with recommendedBinary, not a blocking FAIL', () => {
    const result = T.checkNode('v20.19.2', hermesDiscoverOpts());
    expect(result.status).toBe('WARN');
    expect(result.recommendedBinary).toBe(hermesBinary);
    expect(result.detail).toContain('v20.19.2 (runtime)');
    expect(result.detail).toContain(hermesBinary);
    expect(result.hint).toBe(`Rerun: ${hermesBinary} ${cdpScriptPath} doctor`);

    const model = T.buildDoctorModel([
      result,
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['AABBCCDD'] },
      { status: 'OK', label: 'Permission', detail: 'approved', targetPrefixes: ['AABBCCDD'] },
    ]);
    expect(model).toMatchObject({
      ready: true,
      operationalReady: true,
      failures: 0,
    });
    expect(model.wizard.status).not.toMatch(/blocked at Node/i);
    expect(model.provenCommand).toContain(hermesBinary);
    expect(model.provenCommand).toContain(cdpScriptPath);
    expect(T.doctorNextSteps([
      result,
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['AABBCCDD'] },
    ]).join('\n')).toContain(hermesBinary);
  });

  it('provenCommand uses discovered Node 22 when Permission is WARN (first-run, no daemon)', () => {
    const node = T.checkNode('v20.19.2', hermesDiscoverOpts());
    const model = T.buildDoctorModel([
      node,
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['AABBCCDD'] },
      {
        status: 'WARN',
        label: 'Permission',
        detail: 'browser debugging approval not confirmed for AABBCCDD',
        hint: 'Run: cdp perceive AABBCCDD -C -d 8; if Chrome asks "Allow debugging?", click Allow',
        severity: 'advisory',
        provenCommand: 'cdp list',
        nextProbe: 'cdp perceive AABBCCDD -C -d 8',
        targetPrefixes: ['AABBCCDD'],
      },
    ]);
    expect(model.provenCommand).toContain(hermesBinary);
    expect(model.provenCommand).toContain(cdpScriptPath);
    expect(model.provenCommand).toContain('perceive AABBCCDD');
    expect(model.provenCommand).not.toMatch(/^cdp /);
  });

  it('doctor ask and currentStep use the Node 22 prefix instead of bare cdp doctor/list', () => {
    const node = T.checkNode('v20.19.2', hermesDiscoverOpts());
    const model = T.buildDoctorModel([
      node,
      { status: 'FAIL', label: 'CDP', detail: 'cannot reach 127.0.0.1:9222' },
    ]);
    expect(model.wizard.currentStep).toContain(hermesBinary);
    expect(model.wizard.currentStep).not.toMatch(/\bcdp doctor\b/);
    expect(model.recommendation.ask).toContain(hermesBinary);
    expect(model.recommendation.ask).not.toMatch(/\bcdp doctor\b/);
    expect(model.recommendation.after).toContain(hermesBinary);
    expect(model.recommendation.after).not.toMatch(/^cdp /);
  });

  it('checkNode with v20 and no candidates stays FAIL and blocked', () => {
    const result = T.checkNode('v20.19.2', {
      home: '/home/box',
      env: {},
      execPath: '/usr/bin/node',
      cdpScriptPath,
      fs: isolatedFs,
      spawnSync: isolatedSpawn,
    });
    expect(result.status).toBe('FAIL');
    expect(result.recommendedBinary).toBeFalsy();
    expect(result.hint).not.toMatch(/install Node\.js 22\+/i);
    expect(result.hint).toMatch(/PATH|Hermes|fnm|nvm/i);

    const model = T.buildDoctorModel([
      result,
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['AABBCCDD'] },
    ]);
    expect(model.ready).toBe(false);
    expect(model.operationalReady).toBe(false);
    expect(model.wizard.status).toMatch(/blocked at Node/i);
    expect(T.doctorNextSteps([result]).join('\n')).not.toMatch(/install Node\.js 22\+/i);
  });

  it('checkNode with v22 is OK and does not probe other binaries', () => {
    const result = T.checkNode('v22.23.2', {
      execPath: hermesBinary,
      spawnSync: () => {
        throw new Error('should not probe Node 22 candidates');
      },
    });
    expect(result.status).toBe('OK');
    expect(result.recommendedBinary).toBeFalsy();
  });

  it('bin re-exec helper spawns the discovered Node 22 binary with original args', () => {
    const decision = T.resolveChromeCdpNodeLaunch({
      version: 'v20.19.2',
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/repo/bin/chrome-cdp', 'doctor', '--format', 'json'],
      scriptPath: cdpScriptPath,
      env: {},
      discover: () => ({ binary: hermesBinary, version: 'v22.23.2' }),
    });
    expect(decision).toMatchObject({
      action: 'reexec',
      binary: hermesBinary,
    });
    expect(decision.args).toEqual(['/repo/bin/chrome-cdp', 'doctor', '--format', 'json']);
    expect(decision.env.CHROME_CDP_NODE_REEXEC).toBe('1');
  });

  it('bin re-exec helper keeps the current binary on Node 22 and does not reexec', () => {
    const decision = T.resolveChromeCdpNodeLaunch({
      version: 'v22.23.2',
      execPath: hermesBinary,
      argv: [hermesBinary, '/repo/bin/chrome-cdp', 'list'],
      scriptPath: cdpScriptPath,
      env: {},
      discover: () => {
        throw new Error('should not discover when already on Node 22');
      },
    });
    expect(decision).toMatchObject({
      action: 'use-current',
      binary: hermesBinary,
    });
  });

  it('bin re-exec helper fails closed when Node 20 has no Node 22 candidate', () => {
    const decision = T.resolveChromeCdpNodeLaunch({
      version: 'v20.19.2',
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/repo/bin/chrome-cdp', 'doctor'],
      scriptPath: cdpScriptPath,
      env: {},
      discover: () => null,
    });
    expect(decision.action).toBe('fail');
    expect(decision.message).not.toMatch(/install Node\.js 22\+/i);
    expect(decision.message).toMatch(/PATH|Hermes|fnm|nvm/i);
  });
});

describe('issue #163 doctor next-probe and skip-link @refs', () => {
  function axNode(id, role, name, opts = {}) {
    const properties = [
      ...(opts.url ? [{ name: 'url', value: { type: 'string', value: opts.url } }] : []),
      ...(opts.properties || []),
    ];
    return {
      nodeId: id,
      role: { value: role },
      name: { value: name },
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.childIds ? { childIds: opts.childIds } : {}),
      ...(opts.backendDOMNodeId ? { backendDOMNodeId: opts.backendDOMNodeId } : {}),
      ...(properties.length ? { properties } : {}),
    };
  }

  function licensePage(targetId = '6669325BAAAAAAA1') {
    return {
      targetId,
      title: 'LICENSE',
      url: 'https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE',
    };
  }

  function xProfilePage(targetId = 'F8741D08AAAAAAA2') {
    return {
      targetId,
      title: 'SY239434 / X',
      url: 'https://x.com/SY239434',
    };
  }

  function multiTabDoctorChecks({
    daemonPrefix = '6669325B',
    pages = [
      licensePage(),
      xProfilePage(),
      { targetId: '11111111AAAAAAA3', title: 'MiniMax-Music3', url: 'https://huggingface.co/MiniMaxAI/MiniMax-Music3' },
      { targetId: '22222222AAAAAAA4', title: 'Comfy tutorial', url: 'https://example.com/comfy' },
      { targetId: '33333333AAAAAAA5', title: 'Docs', url: 'https://example.com/docs' },
    ],
  } = {}) {
    const prefixes = pages.map(page => page.targetId.slice(0, 8));
    return [
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Daemons', detail: `1 live: ${daemonPrefix}`, targetPrefixes: [daemonPrefix] },
      {
        status: 'OK',
        label: 'Tabs',
        detail: `${pages.length} debuggable page targets`,
        targetPrefixes: prefixes,
        pages,
      },
      {
        status: 'OK',
        label: 'Permission',
        detail: `debugging approved for ${daemonPrefix}`,
        targetPrefixes: [daemonPrefix],
      },
    ];
  }

  it('does not use daemon[0] / LICENSE blob as next-probe when multiple tabs exist', () => {
    const checks = multiTabDoctorChecks();
    const model = T.buildDoctorModel(checks);
    const text = T.formatDoctorReport(checks);
    const permission = T.checkBrowserPermission({
      daemons: { targetPrefixes: ['6669325B'] },
      tabs: checks.find(check => check.label === 'Tabs'),
      cdp: { status: 'OK' },
    });

    expect(model.provenCommand).toBe('cdp list');
    expect(model.provenCommand).not.toContain('6669325B');
    expect(model.recommendation.run).toBe('cdp list');
    expect(model.wizard.currentStep).toMatch(/\bcdp list\b/);
    expect(model.wizard.currentStep).not.toContain('6669325B');
    expect(permission.provenCommand).toBe('cdp list');
    expect(text).toContain('Proven / next probe: cdp list');
    expect(text).toMatch(/5 tabs — pick with cdp list \/ cdp target --url/);
    expect(text).toMatch(/list is the source of truth for which tab/i);
    expect(text).not.toMatch(/Proven \/ next probe: cdp perceive 6669325B/);

    const perceiveStep = model.nextSteps.find(step => /\bperceive\b/.test(step) && !/--since-action/.test(step));
    expect(perceiveStep).toBeTruthy();
    expect(perceiveStep).toContain('<target-from-list>');
    expect(perceiveStep).not.toContain('6669325B');
    expect(perceiveStep).not.toContain('F8741D08');
    expect(perceiveStep).not.toContain('0625E82A');
    expect(model.recommendation.after).toContain('<target-from-list>');
    expect(model.recommendation.after).not.toMatch(/click (6669325B|F8741D08|0625E82A)/);
    expect(model.recommendedTargetPrefix).not.toBe('6669325B');
    expect(text).toMatch(/sample after list — not a next-probe/);
    expect(T.rankPageTargets(checks.find(check => check.label === 'Tabs').pages)[0].url)
      .not.toMatch(/\/LICENSE(?:$|\.)/i);
  });

  it('ranks an https profile above a LICENSE blob and still perceives a lone LICENSE tab', () => {
    const license = licensePage();
    const profile = xProfilePage();
    expect(T.pageTargetScore(profile)).toBeGreaterThan(T.pageTargetScore(license));
    expect(T.rankPageTargets([license, profile])[0].url).toContain('x.com');

    const single = T.buildDoctorModel([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['6669325B'], pages: [license] },
      { status: 'OK', label: 'Permission', detail: 'approved', targetPrefixes: ['6669325B'] },
    ]);
    expect(single.provenCommand).toBe('cdp perceive 6669325B -C -d 8');
  });

  it('ranks checkBrowserTargets prefixes by page score, not JSON/daemon order', async () => {
    const fetcher = async () => ({
      ok: true,
      json: async () => ([
        {
          type: 'page',
          id: '6669325BAAAAAAA1',
          title: 'LICENSE',
          url: 'https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE',
        },
        {
          type: 'page',
          id: 'F8741D08AAAAAAA2',
          title: 'SY239434 / X',
          url: 'https://x.com/SY239434',
        },
      ]),
    });
    const tabs = await T.checkBrowserTargets({
      cdp: { status: 'OK', host: '127.0.0.1', port: '9224' },
      fetcher,
    });
    expect(tabs.targetPrefixes[0]).toBe('F8741D08');
    expect(tabs.pages[0].url).toContain('x.com');
  });

  it('gives the article tweet an early @ref and keeps skip-links out of @1/@2/@3', () => {
    const nodes = [
      axNode('root', 'WebArea', 'X'),
      axNode('skip', 'link', 'Skip to timeline', { parentId: 'root', backendDOMNodeId: 11, url: '#timeline' }),
      axNode('kbd', 'link', '鍵盤快速鍵', { parentId: 'root', backendDOMNodeId: 12, url: '#' }),
      axNode('nav', 'navigation', 'Primary', { parentId: 'root' }),
      axNode('home', 'link', 'Home', { parentId: 'nav', backendDOMNodeId: 21 }),
      axNode('explore', 'link', 'Explore', { parentId: 'nav', backendDOMNodeId: 22 }),
      axNode('notes', 'link', 'Notifications', { parentId: 'nav', backendDOMNodeId: 23 }),
      axNode('tweet', 'article', 'Latest tweet from SY239434', { parentId: 'root', backendDOMNodeId: 99 }),
    ];
    nodes[0].childIds = ['skip', 'kbd', 'nav', 'tweet'];
    nodes[3].childIds = ['home', 'explore', 'notes'];

    const refMap = new Map();
    const { treeLines } = T.buildPerceiveTree(nodes, { layoutMap: {}, styleHints: {} }, refMap);
    const output = treeLines.join('\n');
    const articleLine = treeLines.find(line => /Latest tweet from SY239434/.test(line));
    const skipLine = treeLines.find(line => /Skip to timeline/i.test(line));
    const kbdLine = treeLines.find(line => /鍵盤快速鍵/.test(line));

    expect(articleLine).toMatch(/@\d+\b/);
    expect(articleLine).toMatch(/@[123]\b/);
    expect(refMap.get(Number(articleLine.match(/@(\d+)/)[1]))).toBe(99);
    expect(skipLine).not.toMatch(/@[123]\b/);
    expect(kbdLine).not.toMatch(/@[123]\b/);
    expect(output).toMatch(/\[article\].*@\d+/);
  });

  it('ranks zh-TW 跳至 skip buttons last and gives the tweet @1', () => {
    const nodes = [
      axNode('root', 'WebArea', 'X'),
      axNode('skipHome', 'button', '', {
        parentId: 'root',
        backendDOMNodeId: 11,
        properties: [{ name: 'aria-label', value: { type: 'string', value: '跳至首頁時間軸' } }],
      }),
      axNode('skipTrend', 'button', '跳至流行趨勢', { parentId: 'root', backendDOMNodeId: 12 }),
      axNode('back', 'button', '返回', { parentId: 'root', backendDOMNodeId: 13 }),
      axNode('nav', 'navigation', 'Primary', { parentId: 'root' }),
      axNode('home', 'link', '首頁', { parentId: 'nav', backendDOMNodeId: 21 }),
      axNode('tweet', 'article', 'Latest tweet from SY239434', { parentId: 'root', backendDOMNodeId: 99 }),
    ];
    nodes[0].childIds = ['skipHome', 'skipTrend', 'back', 'nav', 'tweet'];
    nodes[4].childIds = ['home'];

    expect(T.isSkipLinkAxNode(nodes[1])).toBe(true);
    expect(T.isSkipLinkAxNode(nodes[2])).toBe(true);
    expect(T.isSkipLinkName('跳至首頁時間軸')).toBe(true);
    expect(T.isSkipLinkName('Skip to main content')).toBe(true);

    const refMap = new Map();
    const { treeLines } = T.buildPerceiveTree(nodes, { layoutMap: {}, styleHints: {} }, refMap, {
      maxDepth: 8,
      cursorInteractive: true,
    });
    const articleLine = treeLines.find(line => /Latest tweet from SY239434/.test(line));
    const skipHome = treeLines.find(line => /跳至首頁時間軸/.test(line));
    const skipTrend = treeLines.find(line => /跳至流行趨勢/.test(line));
    const back = treeLines.find(line => /\[button\] 返回/.test(line));

    expect(articleLine).toMatch(/@1\b/);
    expect(refMap.get(1)).toBe(99);
    expect(skipHome).toBeDefined();
    expect(skipHome).not.toMatch(/@[123]\b/);
    expect(skipTrend).not.toMatch(/@[123]\b/);
    expect(back).not.toMatch(/@1\b/);
  });

  it('ranks visible-control aria-label 跳至 / Skip to last', () => {
    const ranked = T.rankPerceiveCursorItems([
      { ariaLabel: '跳至首頁時間軸', selector: 'button[aria-label="跳至首頁時間軸"]' },
      { label: 'Latest tweet', text: 'Latest tweet from SY239434' },
      { ariaLabel: 'Skip to main content', text: '' },
    ]);
    expect(ranked[0].label).toBe('Latest tweet');
    expect(ranked.at(-2).ariaLabel).toMatch(/跳至/);
    expect(ranked.at(-1).ariaLabel).toMatch(/Skip to/i);
  });
});

describe('issues #181-#191 open contracts', () => {
  it('#181 resolves aliases case-insensitively, strips @, and matches stored prefixes', () => {
    const store = T.upsertTargetAlias(T.emptyAliasStore(), {
      name: 'hfmusic',
      targetId: 'F8741D08',
    });
    expect(T.resolveTargetAlias('hfmusic', store).targetId).toBe('F8741D08');
    expect(T.resolveTargetAlias('@HFMusic', store).targetId).toBe('F8741D08');
    expect(T.looksLikeAliasToken('hfmusic')).toBe(true);
    expect(T.looksLikeAliasToken('@hfmusic')).toBe(true);
    expect(T.looksLikeAliasToken('F8741D08')).toBe(false);
    expect(T.unknownAliasError('missing').message).toMatch(/unknown alias "@missing"/);
    expect(T.aliasesForTarget('F8741D08ABCDEF', store.aliases)).toEqual(['hfmusic']);

    const binding = T.resolveLiveTargetBinding({
      requested: 'hfmusic',
      livePages: [{ targetId: 'F8741D08ABCDEF9999', title: 'HF Music', url: 'https://hf.example/' }],
      alias: store.aliases.hfmusic,
    });
    expect(binding.resolvedTargetId).toBe('F8741D08ABCDEF9999');
  });

  it('#182 list JSON recommends pick-tab then text --auto, not starred perceive -C -d 8', () => {
    const model = T.buildPageListModel([
      { targetId: 'AABBCCDD11223344', type: 'page', title: 'Dashboard', url: 'https://example.com/app' },
    ]);
    expect(model.recommendation.stage).toBe('pick-target');
    expect(model.recommendation.run).toBe('cdp list --format json');
    expect(model.nextSteps[0]).not.toMatch(/perceive AABBCCDD.*-C -d 8/);
    expect(model.nextSteps).toEqual(expect.arrayContaining([
      'cdp text <target-from-list> --auto',
      'cdp perceive <target-from-list> --cards',
    ]));
  });

  it('#183 classifies missing/ambiguous targets and unknown flags as list/usage, not doctor', () => {
    expect(T.buildCliErrorRecovery('No live target matching prefix "abc".').kind).toBe('target-resolution');
    expect(T.buildCliErrorRecovery('No live target matching prefix "abc".').run).toMatch(/^cdp list/);
    expect(T.buildCliErrorRecovery('target: 2 pages matched prefix "aa"').kind).toBe('target-resolution');
    expect(T.buildCliErrorRecovery('target: 2 pages matched prefix "aa"').strategy).toBe('choose-longer-prefix');
    expect(T.buildCliErrorRecovery('unknown alias "@hfmusic"').run).toBe('cdp list');
    const unknownFlag = T.buildCliErrorRecovery('click: unknown argument --foo', { cmd: 'click' });
    expect(unknownFlag.kind).toBe('usage');
    expect(unknownFlag.run).toBe('cdp help click');
    expect(unknownFlag.run).not.toBe('cdp doctor');
  });

  it('#183 --exact no-match is target-resolution/list, not unknown/doctor', () => {
    const pages = [{
      targetId: 'AABBCCDD1234',
      title: 'MiniMax-Music3',
      url: 'https://huggingface.co/MiniMaxAI/MiniMax-Music3',
    }];
    expect(() => T.selectPageTarget(pages, {
      url: 'huggingface.co/MiniMaxAI/MiniMax-Music3',
      exact: true,
    })).toThrow(/no page matched.*--exact/);

    const message = 'target: no page matched --url huggingface.co/MiniMaxAI/MiniMax-Music3 --exact. Run: cdp list';
    const recovery = T.buildCliErrorRecovery(message, { cmd: 'target' });
    expect(recovery.kind).toBe('target-resolution');
    expect(recovery.run).toMatch(/^cdp list/);
    expect(recovery.strategy).not.toBe('run-doctor');

    const text = T.formatCliError(new Error(message), { cmd: 'target' });
    expect(text).toMatch(/Kind: target-resolution/);
    expect(text).toMatch(/Next: cdp list/);
    expect(text).not.toMatch(/Kind: unknown/);
    expect(text).not.toMatch(/cdp doctor/);

    const ambiguous = T.buildCliErrorRecovery('target: 2 pages matched; narrow with a more specific --url/--title or --exact');
    expect(ambiguous.kind).toBe('target-resolution');
    expect(ambiguous.strategy).toBe('choose-longer-prefix');
    expect(ambiguous.run).toMatch(/^cdp list/);
  });

  it('#184 click --js works after the selector and unknown flags fail closed', () => {
    expect(T.parseClickArgs(['@1', '--js'])).toMatchObject({ js: true, selector: '@1' });
    expect(T.parseClickArgs(['--js', '#save'])).toMatchObject({ js: true, selector: '#save' });
    expect(T.parseClickArgs(['@7', '--format', 'json', '--compact'])).toMatchObject({
      js: false,
      selector: '@7',
      format: 'json',
      compact: true,
    });
    expect(() => T.parseClickArgs(['@1', '--foo'])).toThrow(/click: unknown argument --foo/);
    expect(T.scrollSettledRectFunctionDeclaration()).toMatch(/Date\.now\(\) \+ 1800/);
    expect(T.scrollSettledRectFunctionDeclaration()).toMatch(/setTimeout/);
  });

  it('#185 report --qa uses live page title and JSON defaults to compact', () => {
    const session = T.createSessionState({ targetId: 'ABC12345FULL', sessionId: 'sid' });
    T.initializeSessionLog(session);
    session.actionLog.push({
      action: 'click',
      ts: session.createdAt + 10,
      url: 'https://example.test/app',
      target: { label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 12 },
      outcome: { status: 'changed' },
    });
    const qa = T.formatSessionReport(session, {
      format: 'json',
      qa: true,
      page: { title: 'Example App', url: 'https://example.test/app' },
    });
    const parsedQa = JSON.parse(qa);
    expect(parsedQa.page.title).toBe('Example App');
    expect(parsedQa.page.url).toContain('example.test/app');

    const json = JSON.parse(T.formatSessionReport(session, { format: 'json' }));
    expect(json.mode).toBe('compact');
    const full = JSON.parse(T.formatSessionReport(session, { format: 'json', lastActions: null }));
    expect(full.mode).not.toBe('compact');
  });

  it('#186 PDF viewer receipts are classified instead of unknown/status', () => {
    expect(T.isPdfViewerContentType('application/pdf')).toBe(true);
    const text = T.formatPdfViewerOutput({
      title: '',
      url: 'https://arxiv.org/pdf/1234.pdf',
      contentType: 'application/pdf',
    }, { targetPrefix: 'AABBCCDD' });
    expect(text).toMatch(/PDF viewer/);
    expect(text).not.toMatch(/\bcdp status\b/);
    const recovery = T.buildCliErrorRecovery(text, { cmd: 'text', err: T.pdfViewerError({ contentType: 'application/pdf' }) });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toMatch(/document\.contentType/);
  });

  it('#187 help [command] prints a topic and blur does not suggest back', () => {
    const topic = T.helpTopicStr('click');
    expect(topic).toMatch(/^cdp click /);
    expect(topic).toContain('[--js|-j]');
    expect(T.helpStr()).toContain('help [command]');
    expect(T.suggestCommands('blur')).not.toContain('back');
    expect(T.commandUsageTemplate('stop')).toMatch(/cdp stop \[target/);
  });

  it('#188 ships a skill-local bin/chrome-cdp launcher and ignores scriptPath-only stale daemons', () => {
    const bin = readFileSync(new URL('../skills/chrome-cdp-ex/bin/chrome-cdp', import.meta.url), 'utf8');
    expect(bin).toContain("'scripts', 'cdp.mjs'");
    expect(bin).toContain('resolveChromeCdpNodeLaunch');
    const current = {
      schema: 'chrome-cdp-ex.daemon-metadata.v1',
      scriptPath: '/repo/skills/chrome-cdp-ex/scripts/cdp.mjs',
      scriptMtimeMs: 2000,
      packageVersion: '2.16.0',
      gitCommit: 'unknown',
    };
    const assessment = T.assessDaemonFreshness({
      targetPrefix: 'AABBCCDD',
      current,
      daemon: { ...current, scriptPath: '/home/box/.hermes/skills/chrome-cdp-ex/scripts/cdp.mjs' },
    });
    expect(assessment.stale).toBe(false);
    expect(assessment.mismatches).toEqual([]);
  });

  it('#188 warns when an installed skill directory is missing bin/chrome-cdp', () => {
    const home = '/home/test';
    const hermesPath = `${home}/.hermes/skills/chrome-cdp-ex`;
    const result = T.checkSkillSymlink({
      home,
      fs: {
        existsSync: path => path === hermesPath,
        lstatSync: () => ({ isSymbolicLink: () => false }),
      },
    });
    expect(result.status).toBe('WARN');
    expect(result.label).toBe('Skill launcher');
    expect(result.detail).toMatch(/bin\/chrome-cdp/);
  });

  it('#189 click unknown flags throw instead of clicking', () => {
    expect(() => T.parseClickArgs(['@1', '--not-a-flag'])).toThrow(/unknown argument --not-a-flag/);
  });

  it('#190 ignores Copilot agent-session 404s as network failures', () => {
    expect(T.isNetworkFailure({
      url: 'https://github.com/copilot/agent-sessions/abc',
      status: 404,
      type: 'Fetch',
    })).toBe(false);
    expect(T.isNetworkFailure({
      url: 'https://example.com/checkout',
      status: 500,
      type: 'Fetch',
    })).toBe(true);
    expect(T.COMMANDS.find(command => command.name === 'nav').feedbackPolicy).toBe('state-change');
  });

  it('#190 ignores incidental GitHub chrome 404s when the document itself 200s', () => {
    expect(T.isNetworkFailure({
      url: 'https://github.com/EndeavorYen/chrome-cdp-ex/issues/181/agent_tasks',
      status: 404,
      type: 'Fetch',
    })).toBe(false);
    expect(T.isNetworkFailure({
      url: 'https://github.com/EndeavorYen/chrome-cdp-ex/issues/181/hovercards',
      status: 404,
      type: 'XHR',
    })).toBe(false);
    expect(T.isNetworkFailure({
      url: 'https://github.com/EndeavorYen/chrome-cdp-ex/issues/999999',
      status: 404,
      type: 'Document',
    })).toBe(true);
    expect(T.isNetworkFailure({
      url: 'https://example.com/api/missing',
      status: 404,
      type: 'Fetch',
    })).toBe(true);

    const diagnosed = T.applyActionObservationDelta({
      action: 'nav',
      target: { targetId: 'ABC12345FULL' },
      dispatch: { ok: true, method: 'navigate' },
      settle: { ok: true, durationMs: 80 },
      effects: { page: { title: 'Issue #181', url: 'https://github.com/EndeavorYen/chrome-cdp-ex/issues/181' } },
    }, {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 2,
        pending: 0,
        entries: [
          {
            method: 'GET',
            url: 'https://github.com/EndeavorYen/chrome-cdp-ex/issues/181',
            status: 200,
            type: 'Document',
          },
          {
            method: 'GET',
            url: 'https://github.com/EndeavorYen/chrome-cdp-ex/issues/181/agent_tasks',
            status: 404,
            type: 'Fetch',
          },
        ],
      },
    });
    expect(diagnosed.effects.networkDelta.failures).toBe(0);
    expect(diagnosed.effects.diagnosis?.kind).not.toBe('network-failure');
    expect(diagnosed.verdict.status).not.toBe('recover');
    const text = T.formatActionText(diagnosed);
    expect(text).not.toMatch(/\bcdp netlog\b/);
    expect(T.COMMANDS.find(command => command.name === 'nav').feedbackPolicy).toBe('state-change');
  });

  it('#191 unchanged cards after scroll are not treated as DOM change', () => {
    expect(T.actionDomDiffShowsChange('unchanged; still first cards; virtualized window did not replace cards')).toBe(false);
    expect(T.actionDomDiffShowsChange('+++ Added\n+ [article] new tweet')).toBe(true);
  });
});

describe('issues #195-#202 open contracts', () => {
  it('#195 treats letter-start hex prefixes as target prefixes, not unknown aliases', () => {
    expect(T.looksLikeAliasToken('F874')).toBe(false);
    expect(T.looksLikeAliasToken('F8')).toBe(false);
    expect(T.looksLikeAliasToken('F')).toBe(false);
    expect(T.looksLikeAliasToken('C48C')).toBe(false);
    expect(T.looksLikeAliasToken('A7BA5C64')).toBe(false);
    expect(T.looksLikeAliasToken('77C5')).toBe(false);
    expect(T.looksLikeHexTargetPrefix('F874')).toBe(true);
    expect(T.looksLikeHexTargetPrefix('F8741D0')).toBe(true);
    expect(T.looksLikeAliasToken('hfmusic')).toBe(true);
    expect(T.looksLikeAliasToken('@F874')).toBe(true);

    const store = T.upsertTargetAlias(T.emptyAliasStore(), {
      name: 'xtest',
      targetId: 'F8741D08ABCDEF99',
    });
    expect(T.resolveTargetAlias('xtest', store).targetId).toBe('F8741D08ABCDEF99');
    expect(T.resolveTargetAlias('F874', store)).toBeNull();

    const binding = T.resolveLiveTargetBinding({
      requested: 'F874',
      livePages: [{ targetId: 'F8741D08ABCDEF99', title: 'X', url: 'https://x.com/' }],
    });
    expect(binding.resolvedTargetId).toBe('F8741D08ABCDEF99');
  });

  it('#196 text rejects unknown flags and compact/json, and flag-only invocation is usage', () => {
    expect(() => T.parseTextArgs(['--auto', '--not-a-real-flag'])).toThrow(/text: unknown argument --not-a-real-flag/);
    expect(() => T.parseTextArgs(['--auto', '--compact'])).toThrow(/text: unknown argument --compact/);
    expect(() => T.parseTextArgs(['--auto', '--format'])).toThrow(/text: unknown argument --format/);
    expect(T.parseTextArgs(['--auto']).auto).toBe(true);

    const unknown = T.buildCliErrorRecovery('text: unknown argument --not-a-real-flag', { cmd: 'text' });
    expect(unknown.kind).toBe('usage');
    expect(unknown.run).toBe('cdp help text');

    const missing = T.buildCliErrorRecovery('text: target prefix is required', { cmd: 'text' });
    expect(missing.kind).toBe('usage');
    expect(missing.run).toBe('cdp help text');
    expect(missing.run).not.toBe('cdp doctor');
  });

  it('#197 fill rejects unknown flags and fails closed on non-input controls', async () => {
    expect(() => T.parseFillArgs(['@1', 'hello', '--not-a-real-flag'])).toThrow(/fill: unknown argument --not-a-real-flag/);
    expect(T.parseFillArgs(['@1', 'hello', '--format', 'json'])).toMatchObject({
      selector: '@1',
      text: 'hello',
      format: 'json',
    });
    expect(T.parseFillArgs(['@1', 'hello', 'world'])).toMatchObject({
      selector: '@1',
      text: 'hello world',
    });
    expect(() => T.normalizeTargetCommandArgs('fill', ['@1', 'hello', '--not-a-real-flag']))
      .toThrow(/fill: unknown argument --not-a-real-flag/);

    const usage = T.buildCliErrorRecovery('fill: unknown argument --not-a-real-flag', { cmd: 'fill' });
    expect(usage.kind).toBe('usage');
    expect(usage.run).toBe('cdp help fill');

    const linkCdp = {
      send(method) {
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({
            result: {
              value: {
                ok: false,
                error: 'fill: a is not a fillable control (<A>). Use click for links/buttons.',
                tag: 'A',
              },
            },
          });
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    await expect(T.fillStr(linkCdp, 'sid', 'a', 'hello', new Map()))
      .rejects.toThrow(/not a fillable control \(<A>\)/);
    expect(T.classifyActionFailure(new Error('fill: @1 is not a fillable control (<A>). Use click for links/buttons.'), {
      action: 'fill',
      target: { targetId: '1D366978', input: '@1' },
    })).toMatchObject({
      kind: 'not-fillable',
      nextCommand: 'cdp help fill',
    });
  });

  it('#198 netlog drops leftover requests from a previous navigation', () => {
    const now = 1_000_000;
    const entries = [
      { method: 'GET', url: 'https://github.com/EndeavorYen/chrome-cdp-ex/issues/99999999', status: 404, duration: 321, size: 0, ts: now - 347_000 },
      { method: 'GET', url: 'https://example.com/', status: 200, duration: 3, size: 0, ts: now - 330_000 },
    ];
    const filtered = T.filterNetlogEntries(entries, { lastNavigationTs: now - 330_000 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toBe('https://example.com/');

    const buf = new T.RingBuffer(100);
    for (const entry of entries) buf.push(entry);
    const out = T.netlogStr(buf, undefined, { lastNavigationTs: now - 330_000 });
    expect(out).toContain('https://example.com/');
    expect(out).not.toContain('github.com');
  });

  it('#199 eval parses flags off the expression and classifies JS errors as eval, not status', () => {
    expect(() => T.parseEvalArgs(['document.title', '--format', 'json']))
      .toThrow(/eval: unknown argument --format/);
    expect(() => T.parseEvalArgs(['document.title', '--compact']))
      .toThrow(/eval: unknown argument --compact/);
    expect(T.parseEvalArgs(['document.title'])).toMatchObject({ expression: 'document.title' });

    const usage = T.buildCliErrorRecovery('eval: unknown argument --format', { cmd: 'eval' });
    expect(usage.kind).toBe('usage');
    expect(usage.run).toBe('cdp help eval');

    const jsError = T.buildCliErrorRecovery("SyntaxError: Unexpected identifier 'format'", {
      cmd: 'eval',
      targetPrefix: '6914C171',
    });
    expect(jsError.kind).toBe('eval');
    expect(jsError.run).toBe('cdp help eval');
    expect(jsError.run).not.toMatch(/cdp status/);
    expect(jsError.kind).not.toBe('unknown');
  });

  it('#200 target with no args is usage / help target, not doctor', () => {
    expect(() => T.parseTargetSelectArgs([])).toThrow(/provide --url and\/or --title/);
    const recovery = T.buildCliErrorRecovery('target: provide --url and/or --title', { cmd: 'target' });
    expect(recovery.kind).toBe('usage');
    expect(recovery.run).toBe('cdp help target');
    expect(recovery.run).not.toBe('cdp doctor');
    const text = T.formatCliError(new Error('target: provide --url and/or --title'), { cmd: 'target' });
    expect(text).toMatch(/Kind: usage/);
    expect(text).toMatch(/Next: cdp help target/);
    expect(text).not.toMatch(/cdp doctor/);
  });

  it('#201 forget of an unknown alias fails closed and does not claim Forgot', () => {
    const store = T.emptyAliasStore();
    expect(() => T.forgetTargetAlias(store, 'nosuchaliasxyz')).toThrow(/unknown alias "@nosuchaliasxyz"/);
    const next = T.forgetTargetAlias(
      T.upsertTargetAlias(store, { name: 'xtest', targetId: 'F8741D08' }),
      'xtest',
    );
    expect(next.removed.name).toBe('xtest');
    expect(next.next.aliases.xtest).toBeUndefined();
    const recovery = T.buildCliErrorRecovery('unknown alias "@nosuchaliasxyz"', { cmd: 'forget' });
    expect(recovery.kind).toBe('target-resolution');
    expect(recovery.run).toMatch(/^cdp list/);
  });

  it('#202 clipboard / copy clicks are expected no-change without overlay or 8s settle', () => {
    expect(T.looksLikeClipboardControl('Copy model name to clipboard')).toBe(true);
    expect(T.looksLikeClipboardControl('Clicked <BUTTON> "Copy model name to clipboard" (@3)')).toBe(true);
    expect(T.looksLikeClipboardControl('Refresh')).toBe(false);
    expect(T.actionDomDiffShowsChange('No changes detected (clipboard action).')).toBe(false);
    expect(T.scrollSettledRectFunctionDeclaration()).toMatch(/aria-label/);

    const recommendation = T.buildNoChangeOutcomeRecommendation({
      action: 'click',
      target: '6914C171',
      targetInput: '@3',
      targetInfo: { input: '@3', label: 'Copy model name to clipboard', expectedOutcome: 'clipboard-no-change' },
    });
    expect(recommendation.strategy).toBe('continue');
    expect(recommendation.blockingSignals).not.toContain('overlay-check-needed');
    expect(recommendation.commands.join('\n')).not.toMatch(/\boverlay\b/);

    const result = T.createActionResult({
      action: 'click',
      target: {
        targetId: '6914C171FULL',
        input: '@3',
        label: 'Copy model name to clipboard',
        expectedOutcome: 'clipboard-no-change',
      },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 80 },
      effects: {
        domDiff: 'No changes detected (clipboard action).',
        console: [],
        network: [],
        navigation: null,
        consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
        exceptionDelta: { count: 0, entries: [] },
        networkDelta: { count: 1, failures: 0, pending: 0, entries: [{ method: 'POST', url: '/api/event', status: 202 }] },
      },
    });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.verdict.needsRecovery).toBe(false);
    expect(result.receipt.blockingSignals || []).not.toContain('overlay-check-needed');
    expect(T.formatActionText(result)).not.toMatch(/\boverlay\b/);
  });
});

describe('issues #204-#208 open contracts', () => {
  it('#204 press no-change Next is not overlay <Key>; usage is Kind:usage / help press', () => {
    expect(T.overlaySelectorArg('Escape', { resolvedBy: 'key', input: 'Escape' })).toBe('');
    expect(T.overlaySelectorArg('a', { resolvedBy: 'key', input: 'a' })).toBe('');
    expect(T.overlaySelectorArg('#save', { resolvedBy: 'selector-or-ref', input: '#save' })).toBe('"#save"');

    const escape = T.buildNoChangeOutcomeRecommendation({
      action: 'press',
      target: '1D366978',
      targetInput: 'Escape',
      targetInfo: { input: 'Escape', resolvedBy: 'key', label: 'Escape', expectedOutcome: 'press-no-change' },
    });
    expect(escape.strategy).toBe('continue');
    expect(escape.blockingSignals).not.toContain('overlay-check-needed');
    expect(escape.commands.join('\n')).not.toMatch(/\boverlay\b/);
    expect(escape.commands.join('\n')).not.toMatch(/\bEscape\b/);

    const space = T.buildNoChangeOutcomeRecommendation({
      action: 'press',
      target: '1D366978',
      targetInput: 'Space',
      targetInfo: { input: 'Space', resolvedBy: 'key', label: 'Space' },
    });
    expect(space.strategy).toBe('continue');
    expect(space.commands.join('\n')).not.toMatch(/\boverlay\b/);

    const result = T.createActionResult({
      action: 'press',
      target: {
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        input: 'Escape',
        resolvedBy: 'key',
        label: 'Escape',
        expectedOutcome: 'press-no-change',
      },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: {
        domDiff: 'No changes detected.',
        console: [],
        network: [],
        navigation: null,
        consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
        exceptionDelta: { count: 0, entries: [] },
        networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
      },
    });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.verdict.needsRecovery).toBe(false);
    expect(T.formatActionText(result)).not.toMatch(/\bcdp overlay\b/);
    expect(T.formatActionText(result)).not.toMatch(/overlay 1D366978 Escape/);

    const unknown = T.classifyActionFailure(new Error('Unknown key: Esc. Supported: enter, tab, escape'), {
      action: 'press',
      target: { targetId: '1D366978', input: 'Esc', resolvedBy: 'key' },
    });
    expect(unknown.kind).toBe('usage');
    expect(unknown.nextCommand).toBe('cdp help press');

    const missing = T.buildCliErrorRecovery('Key name required (Enter, Tab, Escape, Backspace, Space, Arrow*, or single character a-z/A-Z/0-9/punctuation)', {
      cmd: 'press',
      targetPrefix: '1D366978',
    });
    expect(missing.kind).toBe('usage');
    expect(missing.run).toBe('cdp help press');

    const text = T.formatCliError(new Error('Unknown key: Esc. Supported: enter, tab, escape'), {
      cmd: 'press',
      targetPrefix: '1D366978',
    });
    expect(text).toMatch(/Kind: usage/);
    expect(text).toMatch(/Next: cdp help press/);
    expect(text).not.toMatch(/Action failure: unknown/);
    expect(T.pressUsageError('Esc')?.message).toMatch(/Unknown key: Esc/);
    expect(T.pressUsageError(undefined)?.message).toMatch(/Key name required/);
    expect(T.pressUsageError('Escape')).toBeNull();
  });

  it('#205 dismiss-modal with no modal is no-change continue, not dom-changed', () => {
    expect(T.actionDomDiffShowsChange('No changes detected (no modal).')).toBe(false);
    expect(T.overlaySelectorArg('modal', { resolvedBy: 'dialog', input: 'modal' })).toBe('');

    const recommendation = T.buildNoChangeOutcomeRecommendation({
      action: 'dismiss-modal',
      target: '1D366978',
      targetInput: 'modal',
      targetInfo: { input: 'modal', resolvedBy: 'dialog', label: 'modal', expectedOutcome: 'no-modal' },
    });
    expect(recommendation.strategy).toBe('continue');
    expect(recommendation.outcomeStatus).toBe('no-change');
    expect(recommendation.blockingSignals).not.toContain('overlay-check-needed');
    expect(recommendation.commands.join('\n')).not.toMatch(/\boverlay\b/);

    const result = T.createActionResult({
      action: 'dismiss-modal',
      target: {
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        input: 'modal',
        resolvedBy: 'dialog',
        label: 'modal',
        expectedOutcome: 'no-modal',
      },
      dispatch: { ok: true, method: 'dismiss-modal' },
      settle: { ok: true, durationMs: 20 },
      effects: {
        domDiff: 'No changes detected (no modal).',
        console: [],
        network: [],
        navigation: null,
        consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
        exceptionDelta: { count: 0, entries: [] },
        networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
      },
    });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.effects.diagnosis?.kind).not.toBe('dom-changed');
    expect(T.formatActionText(result)).not.toMatch(/Outcome: changed/);
  });

  it('#206 waitfor timeout is Kind:timeout / help waitfor, not unknown/status', () => {
    const selector = T.buildCliErrorRecovery(
      'Timeout: ".does-not-exist-xyz" not found within 1500ms — to wait for specific text content instead, use: waitfor --text "expected text" 120000',
      { cmd: 'waitfor', targetPrefix: '1D366978' },
    );
    expect(selector.kind).toBe('timeout');
    expect(selector.run).toBe('cdp help waitfor');
    expect(selector.run).not.toMatch(/status/);

    const text = T.buildCliErrorRecovery('Timeout: text "ZZZNOPE" not found within 1200ms', {
      cmd: 'waitfor',
      targetPrefix: '1D366978',
    });
    expect(text.kind).toBe('timeout');
    expect(text.run).toBe('cdp help waitfor');

    const anyOf = T.buildCliErrorRecovery('Timeout: any of [ZZZ, NOPE] not found within 1200ms', {
      cmd: 'waitfor',
      targetPrefix: '1D366978',
    });
    expect(anyOf.kind).toBe('timeout');
    expect(anyOf.run).toBe('cdp help waitfor');

    const formatted = T.formatCliError(
      new Error('Timeout: ".does-not-exist-xyz" not found within 1500ms'),
      { cmd: 'waitfor', targetPrefix: '1D366978' },
    );
    expect(formatted).toMatch(/Kind: timeout/);
    expect(formatted).toMatch(/Next: cdp help waitfor/);
    expect(formatted).not.toMatch(/Kind: unknown/);
    expect(formatted).not.toMatch(/cdp status/);

    expect(T.commandUsageTemplate('waitfor', '1D366978')).toBe('cdp help waitfor');
    const missing = T.buildCliErrorRecovery('CSS selector or --text required', {
      cmd: 'waitfor',
      targetPrefix: '1D366978',
    });
    expect(missing.kind).toBe('usage');
    expect(missing.run).toBe('cdp help waitfor');
  });

  it('#207 text --auto PDF Next uses the resolved prefix, not <target>', async () => {
    const printed = T.formatPdfViewerOutput({
      title: '',
      url: 'https://arxiv.org/pdf/2608.12307',
      contentType: 'application/pdf',
    }, { targetPrefix: '9FAD7C71' });
    expect(printed).toContain('cdp eval 9FAD7C71 "document.contentType"');
    expect(printed).not.toContain('<target>');

    let calls = 0;
    const cdp = {
      send(method) {
        if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
        calls += 1;
        return Promise.resolve({
          result: {
            value: JSON.stringify({
              title: '',
              url: 'https://arxiv.org/pdf/2608.12307',
              contentType: 'application/pdf',
            }),
          },
        });
      },
    };
    await expect(T.textStr(cdp, 'sid', ['--auto'], { targetPrefix: '9FAD7C71' }))
      .rejects.toThrow(/cdp eval 9FAD7C71 "document\.contentType"/);
    expect(calls).toBe(1);
    try {
      await T.textStr(cdp, 'sid', ['--auto'], { targetPrefix: '9FAD7C71' });
      throw new Error('expected pdf viewer error');
    } catch (error) {
      if (error.message === 'expected pdf viewer error') throw error;
      expect(error.code).toBe('pdf_viewer');
      expect(error.message).not.toContain('<target>');
    }
  });

  it('#208 qa screenshot capture is bounded and still yields a receipt', async () => {
    expect(T.QA_SCREENSHOT_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    expect(T.qaScreenshotCaptureOptions()).toMatchObject({
      timeoutMs: T.QA_SCREENSHOT_TIMEOUT_MS,
      skipSanityRetry: true,
    });

    T.resetScreenshotTier();
    const cdp = {
      calls: [],
      send(method, params = {}, sessionId, timeout) {
        this.calls.push({ method, params, sessionId, timeout });
        if (method === 'Page.captureScreenshot') {
          throw new Error('Timeout: Page.captureScreenshot');
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.reject(new Error('timeout')), cancel() {} };
      },
    };
    await expect(T.captureScreenshot(cdp, 'sid', { format: 'png' }, {
      ...T.qaScreenshotCaptureOptions(),
      inspectFrame: async () => ({ retry: false }),
    })).rejects.toThrow(/all methods timed out|Timeout: Page\.captureScreenshot/);
    expect(cdp.calls.some(call => call.method === 'Page.captureScreenshot' && call.timeout === T.QA_SCREENSHOT_TIMEOUT_MS)).toBe(true);
    expect(cdp.calls.every(call => call.method !== 'Page.captureScreenshot' || call.timeout === T.QA_SCREENSHOT_TIMEOUT_MS)).toBe(true);

    const model = T.buildQaPageModel({
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
      page: { title: 'Example Domain', url: 'https://example.com/' },
      pageHealth: { status: 'ok', isBlank: false },
      console: { errors: 0, warnings: 0, exceptions: 0 },
      perception: { captured: true, summary: 'Page: Example Domain' },
      screenshots: {},
      errors: ['desktop screenshot: Screenshot failed: all methods timed out (Page.captureScreenshot, fromSurface:false, screencast).'],
    });
    const text = T.formatQaPageReport(model);
    expect(text).toMatch(/QA page: Example Domain/);
    expect(text).toMatch(/Error: desktop screenshot:/);
    expect(text).toMatch(/Verdict:/);
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('issues #210-#217 open contracts', () => {
  it('#210 qa restores the original viewport after a screenshot timeout', async () => {
    const sizes = [];
    let current = { w: 1042, h: 632 };
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-qa-viewport-'));
    const session = T.createSessionState({
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
      sessionId: 'sid',
      logPath: join(tmp, 'session.jsonl'),
      screenshotDir: join(tmp, 'shots'),
    });
    const cdp = {
      send(method, params = {}) {
        if (method === 'Emulation.setDeviceMetricsOverride') {
          sizes.push(`${params.width}x${params.height}`);
          current = { w: params.width, h: params.height };
          return Promise.resolve({});
        }
        if (method === 'Page.captureScreenshot') {
          throw new Error('Timeout: Page.captureScreenshot');
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('innerWidth') && expr.includes('innerHeight')) {
            return Promise.resolve({ result: { value: JSON.stringify(current) } });
          }
          if (expr.includes('document.title')) {
            return Promise.resolve({
              result: { value: JSON.stringify({ title: 'Example Domain', url: 'https://example.com/', contentType: 'text/html' }) },
            });
          }
          if (expr.includes('devicePixelRatio')) {
            return Promise.resolve({ result: { value: 1 } });
          }
          if (expr.includes('visibleTextLength')) {
            return Promise.resolve({
              result: {
                value: JSON.stringify({
                  url: 'https://example.com/',
                  readyState: 'complete',
                  visibleTextLength: 40,
                  elementCount: 12,
                  visibleControlCount: 1,
                  bodyRect: { width: 1042, height: 632 },
                }),
              },
            });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          throw new Error('ax unavailable in this fixture');
        }
        return Promise.resolve({});
      },
    };
    try {
      const out = await T.qaPageStr({
        cdp,
        sid: 'sid',
        session,
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        consoleBuf: new T.RingBuffer(8),
        exceptionBuf: new T.RingBuffer(8),
        refMap: new Map(),
        lastPerceiveStore: { output: null },
        refState: {},
        actionFeedback: async () => '',
      }, []);
      expect(out).toMatch(/Error: desktop screenshot:/);
      expect(sizes[0]).toBe('1440x900');
      expect(sizes.at(-1)).toBe('1042x632');
      expect(current).toEqual({ w: 1042, h: 632 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#211 no-baseline no-op press is no-change, not a tree dump', () => {
    expect(T.noBaselineActionDiffText()).toMatch(/no changes detected/i);
    expect(T.actionDomDiffShowsChange(T.noBaselineActionDiffText())).toBe(false);
    expect(T.actionDomDiffShowsChange('(no action baseline available; run `perceive` before a mutating command)')).toBe(false);

    const result = T.createActionResult({
      action: 'press',
      target: {
        targetId: 'C48C711AFULL',
        input: 'Escape',
        resolvedBy: 'key',
        label: 'Escape',
        expectedOutcome: 'press-no-change',
      },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: {
        domDiff: T.noBaselineActionDiffText(),
        console: [],
        network: [],
        navigation: null,
        consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
        exceptionDelta: { count: 0, entries: [] },
        networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
      },
    });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    const text = T.formatActionText(result);
    expect(text).toMatch(/Outcome: no-change/);
    expect(text).not.toMatch(/Outcome: changed/);
    expect(text).not.toMatch(/no action baseline available/);
    expect(text).not.toMatch(/^Page:/m);
  });

  it('#212 select missing option is Kind:usage, not ReferenceError', async () => {
    const selectEl = {
      tagName: 'SELECT',
      options: [
        { value: '', textContent: '--' },
        { value: 'a', textContent: 'Alpha' },
        { value: 'b', textContent: 'Beta' },
      ],
      selectedIndex: 0,
      value: '',
      dispatchEvent() {},
    };
    let expression = '';
    const cdp = {
      send(method, params = {}) {
        if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
        expression = params.expression;
        const result = runInNewContext(expression, {
          document: {
            querySelector(sel) {
              if (sel === '#s') return selectEl;
              if (sel === '#q') return { tagName: 'INPUT' };
              return null;
            },
          },
          Event: class Event {},
        });
        return Promise.resolve({ result: { value: result } });
      },
    };

    await expect(T.selectStr(cdp, 'sid', '#s', 'zzz')).rejects.toThrow(/No option value=zzz/);
    expect(expression).toContain(JSON.stringify('zzz'));
    expect(expression).not.toMatch(/: value\s*[;}]/);

    await expect(T.selectStr(cdp, 'sid', '#s', 'Alpha')).resolves.toBe('Selected "Alpha"');
    expect(selectEl.value).toBe('a');

    await expect(T.selectStr(cdp, 'sid', '#q', 'a')).rejects.toThrow(/Not a <select>: INPUT/);
    await expect(T.selectStr(cdp, 'sid', '', 'a')).rejects.toThrow(/CSS selector required/);
    await expect(T.selectStr(cdp, 'sid', '#s', undefined)).rejects.toThrow(/Value required/);

    expect(T.classifyActionFailure(new Error('No option value=zzz'), {
      action: 'select',
      target: { targetId: '270379DA', input: '#s' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help select' });
    expect(T.classifyActionFailure(new Error('Not a <select>: INPUT'), {
      action: 'select',
      target: { targetId: '270379DA', input: '#q' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help select' });

    const formatted = T.formatCliError(new Error('No option value=zzz'), {
      cmd: 'select',
      targetPrefix: '270379DA',
    });
    expect(formatted).toMatch(/Kind: usage/);
    expect(formatted).toMatch(/Next: cdp help select/);
    expect(formatted).not.toMatch(/Action failure: unknown/);
    expect(formatted).not.toMatch(/ReferenceError/);
  });

  it('#213 upload of a missing path fails closed and does not plant a ghost file', async () => {
    expect(() => T.assertReadableUploadFiles('/tmp/picky5/no-such-file.bin'))
      .toThrow(/upload: file not found/);
    const cdp = {
      send(method) {
        throw new Error(`CDP ${method} must not run for a missing upload path`);
      },
    };
    await expect(T.uploadStr(cdp, 'sid', '#f', '/tmp/picky5/no-such-file.bin'))
      .rejects.toThrow(/upload: file not found/);

    const usage = T.buildCliErrorRecovery('upload: file not found: /tmp/picky5/no-such-file.bin', { cmd: 'upload' });
    expect(usage.kind).toBe('usage');
    expect(usage.run).toBe('cdp help upload');
    expect(T.classifyActionFailure(new Error('upload: file not found: /tmp/picky5/no-such-file.bin'), {
      action: 'upload',
      target: { targetId: '270379DA', input: '#f' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help upload' });
    expect(T.classifyActionFailure(new Error('Element is not an <input type="file">'), {
      action: 'upload',
      target: { targetId: '270379DA', input: '#q' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help upload' });
  });

  it('#214 wait 0 / missing duration is Kind:usage / help wait, not doctor or status', () => {
    expect(() => T.parseDelayMs('0', { name: 'wait duration' })).toThrow(/at least 1ms/);
    expect(() => T.parseDelayMs(undefined, { name: 'wait duration' })).toThrow(/positive integer/);
    expect(() => T.parseDelayMs('-1', { name: 'wait duration' })).toThrow(/positive integer/);

    const zero = T.buildCliErrorRecovery('wait duration must be at least 1ms', { cmd: 'wait', targetPrefix: '1D366978' });
    expect(zero.kind).toBe('usage');
    expect(zero.run).toBe('cdp help wait');
    expect(zero.run).not.toMatch(/status/);
    expect(zero.run).not.toBe('cdp doctor');

    const missing = T.buildCliErrorRecovery('wait duration must be a positive integer in milliseconds', {
      cmd: 'wait',
      targetPrefix: '1D366978',
    });
    expect(missing.kind).toBe('usage');
    expect(missing.run).toBe('cdp help wait');

    const noTarget = T.buildCliErrorRecovery('wait duration must be at least 1ms', { cmd: 'wait' });
    expect(noTarget.kind).toBe('usage');
    expect(noTarget.run).toBe('cdp help wait');
    expect(noTarget.run).not.toBe('cdp doctor');

    const formatted = T.formatCliError(new Error('wait duration must be at least 1ms'), { cmd: 'wait' });
    expect(formatted).toMatch(/Kind: usage/);
    expect(formatted).toMatch(/Next: cdp help wait/);
    expect(formatted).not.toMatch(/cdp doctor/);
    expect(formatted).not.toMatch(/cdp status/);
    expect(T.commandUsageTemplate('wait', '1D366978')).toBe('cdp help wait');
  });

  it('#215 tab-group unknown group is Kind:usage / tab-group list, not doctor', () => {
    expect(() => T.deleteTabGroup(T.emptyTabGroupStore(), 'picky5')).toThrow(/unknown group "picky5"/);
    expect(T.getTabGroup(T.emptyTabGroupStore(), 'picky5')).toBeNull();

    const recovery = T.buildCliErrorRecovery('tab-group: unknown group "picky5"', { cmd: 'tab-group' });
    expect(recovery.kind).toBe('usage');
    expect(recovery.run).toBe('cdp tab-group list');
    expect(recovery.run).not.toBe('cdp doctor');

    const formatted = T.formatCliError(new Error('tab-group: unknown group "picky5"'), { cmd: 'tab-group' });
    expect(formatted).toMatch(/Kind: usage/);
    expect(formatted).toMatch(/Next: cdp tab-group list/);
    expect(formatted).not.toMatch(/cdp doctor/);
  });

  it('#216 cookiedel of a missing cookie fails closed and does not claim deleted', async () => {
    const calls = [];
    const jar = [{ name: 'picky5', value: 'roundtrip', domain: 'example.com', path: '/' }];
    const cdp = {
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: 'https://example.com/' } });
        }
        if (method === 'Network.getCookies') {
          return Promise.resolve({ cookies: jar.map(cookie => ({ ...cookie })) });
        }
        if (method === 'Network.deleteCookies') {
          const idx = jar.findIndex(cookie => cookie.name === params.name
            && (!params.domain || cookie.domain === params.domain)
            && (!params.path || cookie.path === params.path));
          if (idx !== -1) jar.splice(idx, 1);
          return Promise.resolve({});
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    await expect(T.cookieDelStr(cdp, 'sid', 'nosuchpicky5cookie'))
      .rejects.toThrow(/Cookie not found: nosuchpicky5cookie/);
    expect(calls.some(call => call.method === 'Network.deleteCookies')).toBe(false);

    const deleted = await T.cookieDelStr(cdp, 'sid', 'picky5');
    expect(deleted).toBe('Cookie deleted: picky5');
    expect(calls.some(call => call.method === 'Network.deleteCookies' && call.params.name === 'picky5')).toBe(true);

    const recovery = T.buildCliErrorRecovery('Cookie not found: nosuchpicky5cookie', {
      cmd: 'cookiedel',
      targetPrefix: '1D366978',
    });
    expect(recovery.kind).toBe('usage');
    expect(recovery.run).toBe('cdp cookies 1D366978');
    expect(recovery.run).not.toMatch(/Cookie deleted/);
    const formatted = T.formatCliError(new Error('Cookie not found: nosuchpicky5cookie'), {
      cmd: 'cookiedel',
      targetPrefix: '1D366978',
    });
    expect(formatted).toMatch(/Kind: usage/);
    expect(formatted).not.toMatch(/Cookie deleted/);
  });

  it('#217 hover bounds mouseMoved renderer-ack instead of waiting ~5s', async () => {
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBeLessThan(2000);

    const calls = [];
    const cdp = {
      send(method, params = {}, sessionId, timeoutMs) {
        calls.push({ method, params, sessionId, timeoutMs });
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'root-frame' } } });
        }
        if (method === 'Page.createIsolatedWorld') {
          return Promise.resolve({ executionContextId: 901 });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'hover-node' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          if (String(params.functionDeclaration || '').includes('ownerDocumentGetter')) {
            return Promise.resolve({ result: { value: { connected: true } } });
          }
          return Promise.resolve({
            result: { value: { x: 240, y: 180, w: 28, h: 44, tag: 'A', text: 'Learn more' } },
          });
        }
        if (method === 'Input.dispatchMouseEvent') {
          expect(timeoutMs).toBe(T.HOVER_MOUSE_ACK_TIMEOUT_MS);
          return Promise.reject(new Error('Timeout: Input.dispatchMouseEvent'));
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({
            result: { value: { ok: true, x: 254, y: 202, tag: 'A' } },
          });
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const out = await T.hoverStr(cdp, 'sid', '@1', new Map([[1, 101]]), {});
    expect(out).toMatch(/Hovering over <A>/);
    expect(calls.some(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseMoved')).toBe(true);
    expect(calls.some(call => call.method === 'Input.dispatchMouseEvent' && call.timeoutMs === T.HOVER_MOUSE_ACK_TIMEOUT_MS)).toBe(true);
    const hoverFn = calls
      .filter(call => call.method === 'Runtime.callFunctionOn')
      .map(call => call.params.functionDeclaration || '')
      .find(fn => fn.includes('getBoundingClientRect')) || '';
    expect(hoverFn).toContain('getBoundingClientRect');
    expect(hoverFn).not.toMatch(/requestAnimationFrame/);
    expect(hoverFn).not.toMatch(/Date\.now\(\) \+ 1800/);
    expect(calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(1);

    const css = await T.hoverStr(cdp, 'sid', 'a', new Map(), {});
    expect(css).toMatch(/Hovering over <A>/);
    const mouseCalls = calls.filter(call => call.method === 'Input.dispatchMouseEvent');
    expect(mouseCalls).toHaveLength(2);
    expect(mouseCalls.every(call => call.timeoutMs === T.HOVER_MOUSE_ACK_TIMEOUT_MS)).toBe(true);
    const cssExpr = calls.find(call => call.method === 'Runtime.evaluate')?.params.expression || '';
    expect(cssExpr).not.toMatch(/scrollIntoView/);
    expect(cssExpr).not.toMatch(/requestAnimationFrame/);
  });
});

describe('issues #220-#225 open contracts', () => {
  it('#220 verify-click assertion fail is RC≠0; unused --expect-status is usage', async () => {
    expect(() => T.parseVerifyClickArgs(['#b', '--expect-status', '200']))
      .toThrow(/--expect-status requires --expect-request/);
    expect(() => T.parseVerifyClickArgs(['#b', '--expect-request', 'GET /', '--expect-status', '200']))
      .not.toThrow();

    const failed = T.buildSemanticInteractionModel({
      action: 'click',
      target: { input: '#b', label: '#b' },
      dispatch: { ok: true, method: 'click' },
      effects: { network: [], consoleDelta: {}, exceptionDelta: {} },
    }, { expectText: 'NOPE-NOT-HERE' }, { textMatched: false });
    expect(failed).toMatchObject({ verdict: 'fail' });
    const text = T.formatSemanticInteractionResult(failed);
    expect(text).toMatch(/Verdict: fail/);
    expect(text).toMatch(/Kind: assertion/);
    expect(text).toMatch(/Next: cdp help verify-click/);
    expect(text).not.toMatch(/cdp status/);

    const semantics = T.classifyCommandResultSemantics(
      { ok: true, result: JSON.stringify(failed) },
      { command: 'verify-click' },
    );
    expect(semantics.ok).toBe(false);
    expect(semantics.assertionFailed).toBe(true);
    expect(semantics.dispatchFailed).toBe(false);

    const processLike = { exitCode: 0 };
    const logs = [];
    T.emitTargetCommandResponse(
      { ok: true, result: JSON.stringify(failed) },
      { cmd: 'verify-click', console: { log: value => logs.push(String(value)) }, process: processLike },
    );
    expect(processLike.exitCode).toBe(1);
    expect(logs.join('\n')).toMatch(/"verdict":\s*"fail"/);

    const textProcess = { exitCode: 0 };
    T.emitTargetCommandResponse(
      { ok: true, result: text },
      { cmd: 'verify-click', console: { log() {} }, process: textProcess },
    );
    expect(textProcess.exitCode).toBe(1);

    const usage = T.buildCliErrorRecovery('verify-click: --expect-status requires --expect-request', {
      cmd: 'verify-click',
      targetPrefix: '270379DA',
    });
    expect(usage.kind).toBe('usage');
    expect(usage.run).toBe('cdp help verify-click');
    expect(T.VERIFY_CLICK_SETTLE_MS).toBeLessThan(2000);
    expect(T.VERIFY_CLICK_REQUEST_WAIT_MS).toBeLessThanOrEqual(1500);
  });

  it('#221 tab-group add/create of an unknown target fails closed and does not plant a ghost', () => {
    const live = ['1D3669785EAC5A1A211792636BAE8A07', '270379DA32DEEE448FF70D9EEE154209'];
    expect(T.resolveTabGroupMember('1D366978', { targetIds: live })).toBe('1D366978');
    expect(() => T.resolveTabGroupMember('NOTEXIST', { targetIds: live }))
      .toThrow(/No live target matching prefix "NOTEXIST"/);
    expect(() => T.resolveTabGroupMembers(['NOTEXIST', '1D366978'], { targetIds: live }))
      .toThrow(/No live target matching prefix "NOTEXIST"/);
    expect(T.resolveTabGroupMembers(['1D366978', '270379DA'], { targetIds: live }))
      .toEqual(['1D366978', '270379DA']);

    let store = T.emptyTabGroupStore();
    store = T.upsertTabGroup(store, {
      name: 'picky6',
      members: T.resolveTabGroupMembers(['1D366978', '270379DA'], { targetIds: live }),
    });
    expect(T.getTabGroup(store, 'picky6').members).toEqual(['1D366978', '270379DA']);
    expect(() => T.upsertTabGroup(store, {
      name: 'picky6',
      members: T.resolveTabGroupMembers(['NOTEXIST'], { targetIds: live }),
    })).toThrow(/No live target matching prefix "NOTEXIST"/);
    expect(T.getTabGroup(store, 'picky6').members).toEqual(['1D366978', '270379DA']);

    const recovery = T.buildCliErrorRecovery('No live target matching prefix "NOTEXIST".', { cmd: 'tab-group' });
    expect(recovery.kind).toBe('target-resolution');
    expect(recovery.run).toMatch(/^cdp list/);
    expect(T.listKnownLiveTargetIds({
      listDaemons: () => [{ targetId: '1D3669785EAC5A1A211792636BAE8A07' }],
      readPages: () => [{ targetId: '270379DA32DEEE448FF70D9EEE154209' }],
    })).toEqual(expect.arrayContaining([
      '1D3669785EAC5A1A211792636BAE8A07',
      '270379DA32DEEE448FF70D9EEE154209',
    ]));
  });

  it('#222 batch failed steps make the command RC≠0 and unknown cmds Next help', async () => {
    const unknown = T.formatBatchResults([{
      cmd: 'not-a-cmd',
      ok: false,
      error: 'Unknown command: not-a-cmd',
    }], 'model', { targetId: '270379DA32DEEE448FF70D9EEE154209' });
    const unknownModel = JSON.parse(unknown);
    expect(unknownModel.counts.failed).toBe(1);
    expect(unknownModel.nextSteps).toEqual(['cdp help']);
    expect(unknownModel.nextSteps.join('\n')).not.toMatch(/cdp status 270379DA32DEEE448FF70D9EEE154209/);

    const semantics = T.classifyCommandResultSemantics(
      { ok: true, result: unknown },
      { command: 'batch' },
    );
    expect(semantics.ok).toBe(false);
    expect(semantics.batchFailed).toBe(true);

    const processLike = { exitCode: 0 };
    T.emitTargetCommandResponse(
      { ok: true, result: unknown },
      { cmd: 'batch', console: { log() {} }, process: processLike },
    );
    expect(processLike.exitCode).toBe(1);

    const legacy = JSON.stringify([{ cmd: 'not-a-cmd', ok: false, error: 'Unknown command: not-a-cmd' }], null, 2);
    expect(T.classifyCommandResultSemantics(
      { ok: true, result: legacy },
      { command: 'batch' },
    ).ok).toBe(false);

    await expect(executeCdpCli(
      ['batch', 'ABC12345', 'not-a-cmd foo'],
      { runMain: async ({ console }) => { console.log(legacy); } },
    )).resolves.toMatchObject({ code: 1, stdout: legacy, stderr: '' });
  });

  it('#223 diff-shot screenshot timeout is a classified failure, not a fake 0% diff', async () => {
    expect(T.diffShotScreenshotCaptureOptions()).toMatchObject({
      timeoutMs: T.QA_SCREENSHOT_TIMEOUT_MS,
      skipSanityRetry: true,
      failFastOnTimeout: true,
    });
    expect(T.diffShotScreenshotCaptureOptions().timeoutMs).toBeLessThanOrEqual(3000);

    T.resetScreenshotTier();
    const cdp = {
      calls: [],
      send(method, params = {}, sessionId, timeout) {
        this.calls.push({ method, params, sessionId, timeout });
        if (method === 'Page.captureScreenshot') {
          throw new Error('Timeout: Page.captureScreenshot');
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.reject(new Error('timeout')), cancel() {} };
      },
    };
    await expect(T.captureScreenshot(cdp, 'sid', { format: 'png' }, T.diffShotScreenshotCaptureOptions()))
      .rejects.toThrow(/Timeout: Page\.captureScreenshot/);
    expect(cdp.calls.filter(call => call.method === 'Page.captureScreenshot')).toHaveLength(1);
    expect(cdp.calls[0].timeout).toBe(T.QA_SCREENSHOT_TIMEOUT_MS);
    expect(T.getScreenshotTier()).toBe(1);

    const session = { targetId: '1D366978', screenshotDir: '/tmp/diff-shot-untrusted' };
    await expect(T.diffShotStr(cdp, 'sid', session, { reset: true }))
      .rejects.toThrow(/timed out|untrusted/i);
    const recovery = T.buildCliErrorRecovery('diff-shot: screenshot capture timed out; comparison is untrusted', {
      cmd: 'diff-shot',
      targetPrefix: '1D366978',
    });
    expect(recovery.kind).toBe('timeout');
    expect(recovery.run).toBe('cdp help diff-shot');
    expect(recovery.run).not.toMatch(/status/);
  });

  it('#224 restore/replay missing file is Kind:usage / help, not perceive or status', () => {
    const enoent = new Error("ENOENT: no such file or directory, open '[checkpoint-path-redacted]'");
    expect(T.classifyActionFailure(enoent, {
      action: 'restore',
      target: { targetId: '1D366978' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help restore' });

    const restoreMissing = T.buildCliErrorRecovery(
      "ENOENT: no such file or directory, open '[checkpoint-path-redacted]'",
      { cmd: 'restore', targetPrefix: '1D366978' },
    );
    expect(restoreMissing.kind).toBe('usage');
    expect(restoreMissing.run).toBe('cdp help restore');
    expect(restoreMissing.run).not.toMatch(/perceive|status/);

    const schema = T.buildCliErrorRecovery('restore: unsupported checkpoint schema (missing)', {
      cmd: 'restore',
      targetPrefix: '1D366978',
    });
    expect(schema.kind).toBe('usage');
    expect(schema.run).toBe('cdp help restore');

    const restoreArgs = T.buildCliErrorRecovery('restore requires --file <path> or --json <checkpoint-json>', {
      cmd: 'restore',
      targetPrefix: '1D366978',
    });
    expect(restoreArgs.kind).toBe('usage');
    expect(restoreArgs.run).toBe('cdp help restore');

    const formattedRestore = T.formatCliError(enoent, { cmd: 'restore', targetPrefix: '1D366978' });
    expect(formattedRestore).toMatch(/Kind: usage/);
    expect(formattedRestore).toMatch(/Next: cdp help restore/);
    expect(formattedRestore).not.toMatch(/Action failure: unknown/);
    expect(formattedRestore).not.toMatch(/cdp perceive/);
    expect(formattedRestore).not.toMatch(/cdp status/);

    const replayEnoent = T.buildCliErrorRecovery(
      'ENOENT: no such file or directory, open \'/tmp/picky6/no-such-replay.json\'',
      { cmd: 'replay', targetPrefix: '1D366978' },
    );
    expect(replayEnoent.kind).toBe('usage');
    expect(replayEnoent.run).toBe('cdp help replay');
    const replaySchema = T.buildCliErrorRecovery('replay: unsupported artifact schema (missing)', {
      cmd: 'replay',
      targetPrefix: '1D366978',
    });
    expect(replaySchema.kind).toBe('usage');
    expect(replaySchema.run).toBe('cdp help replay');
    expect(T.commandUsageTemplate('restore', '1D366978')).toBe('cdp help restore');
    expect(T.commandUsageTemplate('replay', '1D366978')).toBe('cdp help replay');
  });

  it('#225 repeat 0 / missing args is Kind:usage / help repeat, not status', () => {
    expect(() => T.parseRepeatArgs(['0', 'eval', '1+1'])).toThrow(/positive integer/);
    expect(() => T.parseRepeatArgs([])).toThrow(/repeat requires/);

    const zero = T.buildCliErrorRecovery('repeat: count must be a positive integer, got "0"', {
      cmd: 'repeat',
      targetPrefix: '270379DA',
    });
    expect(zero.kind).toBe('usage');
    expect(zero.run).toBe('cdp help repeat');
    expect(zero.run).not.toMatch(/status/);

    const missing = T.buildCliErrorRecovery('repeat requires <count> <cmd> [args...]', {
      cmd: 'repeat',
      targetPrefix: '270379DA',
    });
    expect(missing.kind).toBe('usage');
    expect(missing.run).toBe('cdp help repeat');

    const formatted = T.formatCliError(new Error('repeat: count must be a positive integer, got "0"'), {
      cmd: 'repeat',
      targetPrefix: '270379DA',
    });
    expect(formatted).toMatch(/Kind: usage/);
    expect(formatted).toMatch(/Next: cdp help repeat/);
    expect(formatted).not.toMatch(/cdp status/);
    expect(T.commandUsageTemplate('repeat', '270379DA')).toBe('cdp help repeat');
  });
});

describe('issues #227-#231 open contracts', () => {
  it('#227 missing loadall selector is RC≠0 and does not claim disappeared', async () => {
    expect(T.parseLoadAllArgs(['#more'])).toEqual({
      selector: '#more',
      intervalMs: T.LOADALL_DEFAULT_INTERVAL_MS,
      timeoutMs: T.LOADALL_DEFAULT_TIMEOUT_MS,
    });
    expect(T.parseLoadAllArgs(['#more', '400'])).toMatchObject({ selector: '#more', intervalMs: 400, timeoutMs: 30_000 });
    expect(T.parseLoadAllArgs(['#more', '--timeout-ms', '800'])).toMatchObject({ timeoutMs: 800, intervalMs: 1500 });
    expect(() => T.parseLoadAllArgs([])).toThrow(/CSS selector required/);

    const topic = T.helpTopicStr('loadall');
    expect(topic).toMatch(/\[interval-ms\]/);
    expect(topic).toMatch(/timeout-ms/);
    expect(topic).toMatch(/click interval/);

    const cdp = {
      send(method, params = {}) {
        const expr = method === 'Runtime.evaluate' ? String(params.expression || '') : '';
        if (expr.includes('__chromeCdpExClickProbe')) {
          return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: false } } });
        }
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: null } });
        return Promise.resolve({});
      },
    };
    await expect(T.loadAllStr(cdp, 'sid', '#nope-load', 0, { timeoutMs: 200 }))
      .rejects.toThrow(/Element not found: #nope-load/);

    const missing = T.formatCliError(new Error('Element not found: #nope-load'), {
      cmd: 'loadall',
      targetPrefix: 'C48C711A',
    });
    expect(missing).toMatch(/Kind: selector/);
    expect(missing).toMatch(/Next: cdp perceive C48C711A -C -d 8/);
    expect(missing).not.toMatch(/disappeared/);
    expect(missing).not.toMatch(/Kind: unknown/);

    const usage = T.formatCliError(new Error('CSS selector required'), {
      cmd: 'loadall',
      targetPrefix: 'C48C711A',
    });
    expect(usage).toMatch(/Kind: usage/);
    expect(usage).toMatch(/Next: cdp help loadall/);
  });

  it('#227 persistent loadall control fails at the cap and client abort stops the loop', async () => {
    const cdp = {
      clicks: 0,
      send(method, params = {}) {
        const expr = method === 'Runtime.evaluate' ? String(params.expression || '') : '';
        if (expr.includes('__chromeCdpExClickProbe')) {
          return Promise.resolve({
            result: {
              value: expr.includes('installed: true')
                ? { cdpClickProbe: true, ok: true, installed: true, scope: 'top' }
                : { cdpClickProbe: true, ok: true, seen: ['click'] },
            },
          });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: { x: 10, y: 20 } } });
        }
        if (method === 'Input.dispatchMouseEvent') this.clicks += 1;
        return Promise.resolve({});
      },
    };
    await expect(T.loadAllStr(cdp, 'sid', '#more', 0, { timeoutMs: 80 }))
      .rejects.toThrow(/still present after \d+ click\(s\) \(timeout 80ms\)/);
    expect(cdp.clicks).toBeGreaterThan(0);

    const timeoutText = T.formatCliError(
      new Error('loadall: "#more" still present after 3 click(s) (timeout 80ms)'),
      { cmd: 'loadall', targetPrefix: 'C48C711A' },
    );
    expect(timeoutText).toMatch(/Kind: timeout/);
    expect(timeoutText).toMatch(/Next: cdp help loadall/);
    expect(timeoutText).not.toMatch(/until it disappeared/);
    expect(timeoutText).not.toMatch(/click Allow/);

    const abortCdp = {
      send(method, params = {}) {
        const expr = method === 'Runtime.evaluate' ? String(params.expression || '') : '';
        if (expr.includes('__chromeCdpExClickProbe')) {
          return Promise.resolve({
            result: {
              value: expr.includes('installed: true')
                ? { cdpClickProbe: true, ok: true, installed: true, scope: 'top' }
                : { cdpClickProbe: true, ok: true, seen: ['click'] },
            },
          });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: { x: 10, y: 20 } } });
        }
        return Promise.resolve({});
      },
    };
    const controller = new AbortController();
    const pending = T.daemonRequestStorage.run({ signal: controller.signal }, () => (
      T.loadAllStr(abortCdp, 'sid', '#b', 40, { timeoutMs: 5000 })
    ));
    setTimeout(() => controller.abort(new Error('loadall: aborted')), 15);
    await expect(pending).rejects.toThrow(/aborted/);
    const aborted = T.formatCliError(new Error('loadall: aborted'), {
      cmd: 'loadall',
      targetPrefix: '270379DA',
    });
    expect(aborted).toMatch(/Kind: timeout/);
    expect(aborted).toMatch(/Next: cdp help loadall/);
    expect(aborted).not.toMatch(/click Allow/);
    expect(aborted).not.toMatch(/Kind: unknown/);
  });

  it('#228 realistic click uses the buttons bitmask and fails fast without overlay on a stuck <a href>', async () => {
    expect(T.isNavigatingHref('https://www.iana.org/help/example-domains', 'https://example.com/')).toBe(true);
    expect(T.isNavigatingHref('#section', 'https://example.com/')).toBe(false);
    expect(T.CLICK_NAVIGATION_WAIT_MS).toBeLessThanOrEqual(500);

    const events = [];
    let probeSeen = [];
    await T.dispatchClick({
      send(method, params = {}, _sessionId, _timeout) {
        const src = method === 'Runtime.evaluate'
          ? String(params.expression || '')
          : String(params.functionDeclaration || '');
        if (src.includes('__chromeCdpExClickProbe')) {
          if (src.includes('installed: true')) {
            probeSeen = [];
            return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: 'top' } } });
          }
          return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, seen: probeSeen.slice() } } });
        }
        if (method === 'Input.dispatchMouseEvent') {
          events.push(params);
          if (params.type === 'mouseReleased') probeSeen.push('mousedown', 'click');
        }
        return Promise.resolve({});
      },
    }, 'sid', 12, 34);
    expect(events).toEqual([
      expect.objectContaining({ type: 'mouseMoved', button: 'none', buttons: 0, pointerType: 'mouse', x: 12, y: 34 }),
      expect.objectContaining({ type: 'mousePressed', button: 'left', buttons: 1, pointerType: 'mouse' }),
      expect.objectContaining({ type: 'mouseReleased', button: 'left', buttons: 0, pointerType: 'mouse' }),
    ]);

    const noNav = T.formatCliError(
      new Error('Click on <A href="https://www.iana.org/help/example-domains"> did not navigate. Try jsclick or click --js.'),
      { cmd: 'click', targetPrefix: '1D366978' },
    );
    expect(noNav).toMatch(/Kind: no-navigation/);
    expect(noNav).toMatch(/Next: cdp jsclick 1D366978 a/);
    expect(noNav).not.toMatch(/overlay/);
    expect(noNav).not.toMatch(/Kind: unknown/);

    const recommendation = T.buildNoChangeOutcomeRecommendation({
      action: 'click',
      target: '1D366978',
      targetInput: 'a',
      targetInfo: { input: 'a', label: 'Learn more', dispatchText: 'Clicked <A> "Learn more"' },
    });
    expect(recommendation.blockingSignals).not.toContain('overlay-check-needed');
    expect(recommendation.commands.join('\n')).not.toMatch(/\boverlay\b/);
  });

  it('#228 click --qa names the live page from page-health evidence', () => {
    expect(T.pageHealthScript()).toMatch(/document\.title/);
    const health = T.classifyPageHealth({
      url: 'https://example.com/',
      title: 'Example Domain',
      readyState: 'complete',
      visibleTextLength: 80,
      elementCount: 12,
      visibleControlCount: 1,
      bodyRect: { width: 800, height: 600 },
    });
    expect(health.evidence).toMatchObject({ url: 'https://example.com/', title: 'Example Domain' });

    const summary = T.buildQaSummaryModel({
      page: { url: '', title: '' },
      pageHealth: health,
      console: { errors: 0, exceptions: 0 },
      network: { failures: 0 },
      action: { outcome: 'no-change', dispatch: { ok: true }, changed: false },
      targetPrefix: '1D366978',
    });
    expect(summary.page).toMatchObject({
      url: 'https://example.com/',
      title: 'Example Domain',
    });
    const text = T.formatQaSummaryText(summary);
    expect(text).toContain('Example Domain');
    expect(text).toContain('https://example.com/');
    expect(text).not.toContain('(untitled)');
    expect(text).not.toContain('(unknown)');
  });

  it('#228 treats a Document GET / href change as navigation instead of 8s no-change + overlay', () => {
    expect(T.shouldSkipActionDomSettle(
      'https://example.com/',
      'https://www.iana.org/help/example-domains',
    )).toBe(true);
    expect(T.shouldSkipActionDomSettle('https://example.com/', 'https://example.com/')).toBe(false);
    expect(T.formatActionNavigationDiff(
      'https://example.com/',
      'https://www.iana.org/help/example-domains',
    )).toMatch(/Navigated.*example\.com.*example-domains/);

    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: {
        targetId: '1D366978FULL',
        input: 'a',
        label: 'Learn more',
        dispatchText: 'Clicked <A> "Learn more"',
      },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 180 },
      effects: {
        domDiff: T.noBaselineActionDiffText(),
        console: [],
        network: [],
        navigation: {
          from: 'https://example.com/',
          to: 'https://www.iana.org/help/example-domains',
          changed: true,
        },
        pageHealth: {
          status: 'populated',
          isBlank: false,
          evidence: {
            url: 'https://www.iana.org/help/example-domains',
            title: 'Example Domains',
          },
        },
      },
      nextHint: null,
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 0,
        pending: 0,
        entries: [{
          method: 'GET',
          url: 'https://www.iana.org/help/example-domains',
          status: 200,
          type: 'Document',
          duration: 60,
        }],
      },
    });

    expect(result.outcome).toMatchObject({
      status: 'changed',
      changed: true,
      evidence: 'navigation',
    });
    expect(result.receipt.outcome).toBe('changed');
    expect(result.receipt.blockingSignals || []).not.toContain('overlay-check-needed');
    expect(result.recommendation.commands.join('\n')).not.toMatch(/\boverlay\b/);
    expect(T.formatActionText(result)).toContain('Network sample: GET /help/example-domains -> 200 in 60ms');
    expect(T.formatActionText(result)).not.toMatch(/Outcome: no-change/);
    expect(result.settle.durationMs).toBeLessThan(500);

    const networkOnly = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: '1D366978FULL', input: 'a', label: 'Learn more' },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 90 },
      effects: { domDiff: T.noBaselineActionDiffText(), console: [], network: [], navigation: null },
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 0,
        pending: 0,
        entries: [{
          method: 'GET',
          url: 'https://www.iana.org/help/example-domains',
          status: 200,
          type: 'Document',
          duration: 60,
        }],
      },
    });
    expect(networkOnly.outcome).toMatchObject({ status: 'changed', changed: true, evidence: 'navigation' });
    expect(networkOnly.receipt.blockingSignals || []).not.toContain('overlay-check-needed');

    const hrefOnly = T.createActionResult({
      action: 'click',
      target: { targetId: '1D366978FULL', input: 'a', label: 'Learn more' },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 80 },
      effects: {
        domDiff: T.noBaselineActionDiffText(),
        console: [],
        network: [],
        navigation: {
          from: 'https://example.com/',
          to: 'https://www.iana.org/help/example-domains',
          changed: true,
        },
      },
    });
    expect(hrefOnly.outcome).toMatchObject({ status: 'changed', changed: true, evidence: 'navigation' });
    expect(hrefOnly.receipt.blockingSignals || []).not.toContain('overlay-check-needed');
  });

  it('#228 fail-fast no-navigation stays within 500ms even if location.href eval hangs', async () => {
    const started = Date.now();
    const cdp = {
      send() {
        return new Promise(() => {});
      },
    };
    await expect(T.confirmClickFollowedHref(cdp, 'sid', {
      tag: 'A',
      href: 'https://www.iana.org/help/example-domains',
      pageHref: 'https://example.com/',
    })).rejects.toThrow(/did not navigate/);
    expect(Date.now() - started).toBeLessThanOrEqual(T.CLICK_NAVIGATION_WAIT_MS + 150);

    const hangSettleStarted = Date.now();
    await expect(T.waitForSettle(cdp, 'sid', 120)).resolves.toMatch(/timeout|stable/);
    expect(Date.now() - hangSettleStarted).toBeLessThan(400);
  });

  it('#228 click --qa names the live page on the no-navigation failure path', async () => {
    const failure = T.formatActionFailure(
      new Error('Click on <A href="https://www.iana.org/help/example-domains"> did not navigate. Try jsclick or click --js.'),
      {
        action: 'click',
        target: {
          targetId: '1D366978FULL',
          input: 'a',
          page: { title: 'Example Domain', url: 'https://example.com/' },
        },
      },
    );
    expect(failure).toMatch(/Action failure: no-navigation/);
    expect(failure).toContain('Example Domain');
    expect(failure).toContain('https://example.com/');
    expect(failure).not.toMatch(/Action failure: overlay/);
    expect(failure).not.toMatch(/Next:.*\boverlay\b/);

    let captured = null;
    await expect(T.runActionWithFeedback({
      action: 'click',
      target: {
        targetId: '1D366978FULL',
        input: 'a',
        label: 'Learn more',
        page: { title: 'Example Domain', url: 'https://example.com/' },
      },
      dispatch: async () => {
        throw new Error('Click on <A href="https://www.iana.org/help/example-domains"> did not navigate. Try jsclick or click --js.');
      },
      feedbackPolicy: 'settle-diff',
      observe: async () => T.noBaselineActionDiffText(),
      enrichActionResult: (result) => {
        result.effects.page = result.target.page;
        result.effects.pageHealth = {
          status: 'populated',
          isBlank: false,
          evidence: result.target.page,
        };
      },
      onActionResult: (result) => { captured = result; },
      format: { format: 'text', qa: true },
    })).rejects.toThrow(/Example Domain/);

    expect(captured.dispatch.ok).toBe(false);
    const qa = T.formatActionResultOutput(captured, { qa: true });
    expect(qa).toContain('Example Domain');
    expect(qa).toContain('https://example.com/');
    expect(qa).not.toContain('(untitled)');
    expect(qa).not.toContain('(unknown)');
  });

  it('#229 batch --parallel allows reads and classifies mutating mixes as usage', () => {
    for (const [cmd, args] of [
      ['list', []],
      ['current', []],
      ['status', []],
      ['console', []],
      ['overlay', []],
      ['dialog', []],
      ['viewport', []],
      ['perceive', ['--qa']],
      ['summary', []],
      ['text', ['--auto']],
      ['eval', ['1+1']],
      ['eval', ['document.title']],
      ['cookies', []],
    ]) {
      expect(T.isBatchParallelUnsafeCommand(cmd, args), `${cmd} ${(args || []).join(' ')}`).toBe(false);
    }
    expect(T.isBatchParallelUnsafeCommand('click', ['a'])).toBe(true);
    expect(T.isBatchParallelUnsafeCommand('dialog', ['accept'])).toBe(true);
    expect(T.isBatchParallelUnsafeCommand('viewport', ['800x600'])).toBe(true);

    const mutating = T.formatCliError(
      new Error('batch --parallel: click mutate shared state — use sequential batch'),
      { cmd: 'batch', targetPrefix: '1D366978' },
    );
    expect(mutating).toMatch(/Kind: usage/);
    expect(mutating).toMatch(/Next: cdp help batch/);
    expect(mutating).not.toMatch(/Kind: unknown/);
    expect(mutating).not.toMatch(/cdp status 1D366978/);
    expect(T.commandUsageTemplate('batch', '1D366978')).toBe('cdp help batch');
  });

  it('#230 failed flow assert is Kind:assertion / help flow, not status', async () => {
    const out = await T.flowStr({
      run: async () => ({ ok: true, result: 'ok' }),
      settle: async () => '',
      assertCondition: async () => ({ matched: false, description: 'selector #nope exists' }),
    }, 'assert selector #nope; summary', {
      format: 'json',
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
    });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.flow.v1',
      halted: true,
      counts: { failed: 1 },
      failedStep: {
        kind: 'assert',
        failureKind: 'assertion',
        nextCommand: 'cdp help flow',
        error: 'Assertion failed: selector #nope exists',
      },
      nextSteps: ['cdp help flow'],
    });
    expect(parsed.nextSteps.join('\n')).not.toMatch(/cdp status 1D3669785EAC5A1A211792636BAE8A07/);

    const text = await T.flowStr({
      run: async () => ({ ok: true, result: 'ok' }),
      settle: async () => '',
      assertCondition: async () => ({ matched: false, description: 'text includes "NOPE"' }),
    }, 'assert text NOPE', { targetId: '1D3669785EAC5A1A211792636BAE8A07', throwOnFailure: true }).catch(err => err.message);
    expect(text).toMatch(/Assertion failed/);
    expect(text).toMatch(/Flow halted/);
    const formatted = T.formatCliError(new Error(text), {
      cmd: 'flow',
      targetPrefix: '1D366978',
    });
    expect(formatted).toMatch(/Kind: assertion/);
    expect(formatted).toMatch(/Next: cdp help flow/);
    expect(formatted).not.toMatch(/Kind: unknown/);
    expect(formatted).not.toMatch(/cdp status 1D366978/);
  });

  it('#231 cascade marks the winning rule when specified ≠ computed', async () => {
    const cdp = {
      send(method) {
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 10 });
        if (method === 'CSS.getMatchedStylesForNode') {
          return Promise.resolve({
            matchedCSSRules: [
              {
                rule: {
                  selectorList: { text: 'h1' },
                  origin: 'user-agent',
                  style: {
                    styleSheetId: 'ua.css',
                    range: { startLine: 0 },
                    cssProperties: [
                      { name: 'font-size', value: '2em' },
                      { name: 'font-weight', value: 'bold' },
                      { name: 'display', value: 'block' },
                    ],
                  },
                },
              },
              {
                rule: {
                  selectorList: { text: 'h1' },
                  origin: 'regular',
                  style: {
                    styleSheetId: 'page.css',
                    range: { startLine: 1 },
                    cssProperties: [{ name: 'font-size', value: '1.5em' }],
                  },
                },
              },
            ],
            inherited: [],
          });
        }
        if (method === 'CSS.getComputedStyleForNode') {
          return Promise.resolve({
            computedStyle: [
              { name: 'font-size', value: '24px' },
              { name: 'font-weight', value: '700' },
              { name: 'display', value: 'block' },
            ],
          });
        }
        if (method === 'CSS.getStyleSheetText') return Promise.resolve({ text: 'h1{}' });
        return Promise.resolve({});
      },
    };
    const fontSize = JSON.parse(await T.cascadeStr(cdp, 'sid', 'h1', 'font-size', new Map(), null, { format: 'json' }));
    expect(fontSize.properties[0].winner).toMatchObject({ value: '1.5em', origin: 'regular' });
    expect(fontSize.properties[0].rules.some(rule => rule.winner)).toBe(true);

    const fontWeight = JSON.parse(await T.cascadeStr(cdp, 'sid', 'h1', 'font-weight', new Map(), null, { format: 'json' }));
    expect(fontWeight.properties[0].winner).toMatchObject({ value: 'bold' });

    const display = JSON.parse(await T.cascadeStr(cdp, 'sid', 'h1', 'display', new Map(), null, { format: 'json' }));
    expect(display.properties[0].winner).toMatchObject({ value: 'block' });
    expect(display.properties[0].rules[0].winner).toBe(true);
  });

  it('#234 click --qa names the post-navigation page, not the pre-nav identity', () => {
    const result = T.createActionResult({
      action: 'click',
      target: {
        targetId: '1D366978FULLTARGET',
        input: 'a',
        label: 'Learn more',
        page: { title: 'Example Domain', url: 'https://example.com/' },
      },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 325 },
      effects: {
        page: { title: 'Example Domain', url: 'https://example.com/' },
        pageHealth: {
          status: 'populated',
          isBlank: false,
          confidence: 'high',
          evidence: {
            url: 'https://www.iana.org/help/example-domains',
            title: 'Example Domains',
            changed: true,
          },
        },
        navigation: {
          from: 'https://example.com/',
          to: 'https://www.iana.org/help/example-domains',
          changed: true,
        },
        domDiff: T.formatActionNavigationDiff(
          'https://example.com/',
          'https://www.iana.org/help/example-domains',
        ),
        console: [],
        network: [],
      },
      nextHint: null,
    });

    const text = T.formatActionResultOutput(result, { qa: true });
    expect(text).toMatch(/^QA summary: pass/m);
    expect(text).toContain('Page: Example Domains');
    expect(text).toContain('URL: https://www.iana.org/help/example-domains');
    expect(text).toContain('Changed: changed');
    expect(text).not.toMatch(/Page: Example Domain$/m);
    expect(text).not.toContain('URL: https://example.com/');

    const parsed = JSON.parse(T.formatActionResultOutput(result, { qa: true, format: 'json' }));
    expect(parsed.summary.page).toMatchObject({
      url: 'https://www.iana.org/help/example-domains',
      title: 'Example Domains',
    });
    expect(parsed.summary.pageHealth.evidence).toMatchObject({
      url: 'https://www.iana.org/help/example-domains',
      title: 'Example Domains',
    });
    expect(parsed.summary.changed).toBe('changed');
  });

  it('#235 report --qa and report on a Chrome PDF viewer use pdf-viewer.v1, not perceive', async () => {
    const session = T.createSessionState({ targetId: '9FAD7C71FULLTARGET', sessionId: 'sid' });
    T.initializeSessionLog(session);
    const page = {
      title: '',
      url: 'https://arxiv.org/pdf/2608.12307',
      contentType: 'application/pdf',
    };

    const qaText = T.formatSessionReport(session, { qa: true, page });
    expect(qaText).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(qaText).toContain('cdp eval 9FAD7C71 "document.contentType"');
    expect(qaText).not.toMatch(/QA summary: pass/);
    expect(qaText).not.toMatch(/Page health: populated/);
    expect(qaText).not.toMatch(/cdp perceive 9FAD7C71 -C -d 8/);
    expect(qaText).not.toMatch(/cdp click 9FAD7C71 @ref/);

    const qaJson = JSON.parse(T.formatSessionReport(session, { format: 'json', qa: true, page }));
    expect(qaJson.schema).toBe('chrome-cdp-ex.pdf-viewer.v1');
    expect(qaJson.nextCommand).toBe('cdp eval 9FAD7C71 "document.contentType"');
    expect(qaJson).not.toMatchObject({ ok: true });

    const reportText = T.formatSessionReport(session, { page });
    expect(reportText).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(reportText).toContain('cdp eval 9FAD7C71 "document.contentType"');
    expect(reportText).not.toMatch(/cdp perceive 9FAD7C71 -C -d 8/);
    expect(reportText).not.toMatch(/cdp click 9FAD7C71 @ref/);

    const reportJson = JSON.parse(T.formatSessionReport(session, { format: 'json', page }));
    expect(reportJson.nextSteps.join('\n')).toContain('cdp eval 9FAD7C71 "document.contentType"');
    expect(reportJson.nextSteps.join('\n')).not.toMatch(/cdp perceive 9FAD7C71 -C -d 8/);
    expect(reportJson.nextSteps.join('\n')).not.toMatch(/cdp click 9FAD7C71 @ref/);
    expect(reportJson.recommendation.commands.join('\n')).toContain('cdp eval 9FAD7C71 "document.contentType"');

    const handler = T.createReportCommandHandler(session, {
      cdp: {},
      sessionId: 'sid',
      pageInfo: async () => page,
    });
    const qaResult = await handler({ args: ['--qa'] });
    expect(qaResult.value).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(qaResult.value).toContain('cdp eval 9FAD7C71 "document.contentType"');
    expect(qaResult.value).not.toMatch(/Next: cdp perceive/);

    const defaultResult = await handler({ args: [] });
    expect(defaultResult.value).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(defaultResult.value).toContain('cdp eval 9FAD7C71 "document.contentType"');
    expect(defaultResult.value).not.toMatch(/cdp perceive 9FAD7C71 -C -d 8/);
    expect(defaultResult.value).not.toMatch(/cdp click 9FAD7C71 @ref/);
  });
});

describe('issues #237-#239 open contracts', () => {
  const PDF_TARGET_ID = '9FAD7C71E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = '9FAD7C71';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('#237 responsive-audit restores the original viewport after the last audited size', async () => {
    const sizes = [];
    let current = { w: 1042, h: 632 };
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-responsive-viewport-'));
    const session = T.createSessionState({
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
      sessionId: 'sid',
      logPath: join(tmp, 'session.jsonl'),
      screenshotDir: join(tmp, 'shots'),
    });
    T.resetScreenshotTier();
    const cdp = {
      send(method, params = {}) {
        if (method === 'Emulation.setDeviceMetricsOverride') {
          sizes.push(`${params.width}x${params.height}`);
          current = { w: params.width, h: params.height };
          return Promise.resolve({});
        }
        if (method === 'Page.captureScreenshot') {
          return Promise.resolve({ data: TINY_PNG });
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('{w:window.innerWidth') && expr.includes('innerHeight')) {
            return Promise.resolve({ result: { value: JSON.stringify(current) } });
          }
          if (expr.includes('document.title')) {
            return Promise.resolve({
              result: { value: JSON.stringify({ title: 'Example Domain', url: 'https://example.com/', contentType: 'text/html' }) },
            });
          }
          if (expr.includes('devicePixelRatio')) {
            return Promise.resolve({ result: { value: 1 } });
          }
          if (expr.includes('overflowX') || expr.includes('clippedControls')) {
            return Promise.resolve({
              result: {
                value: JSON.stringify({
                  url: 'https://example.com/',
                  title: 'Example Domain',
                  viewport: `${current.w}x${current.h}`,
                  scroll: { width: current.w, height: current.h, clientWidth: current.w, clientHeight: current.h },
                  overflowX: false,
                  controlCount: 1,
                  controls: [{ tag: 'a', text: 'More information...' }],
                  controlsTruncated: false,
                  maxControls: 12,
                  clippedControls: [],
                  overlaps: [],
                  pageHealthSignals: {
                    url: 'https://example.com/',
                    readyState: 'complete',
                    visibleTextLength: 40,
                    elementCount: 12,
                    visibleControlCount: 1,
                    bodyRect: { width: current.w, height: current.h },
                  },
                }),
              },
            });
          }
          return Promise.resolve({ result: { value: JSON.stringify({ retry: false }) } });
        }
        return Promise.resolve({});
      },
    };
    try {
      const out = await T.responsiveAuditStr(
        cdp,
        'sid',
        session,
        '1D3669785EAC5A1A211792636BAE8A07',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        ['--viewport', '800x600', '--format', 'json'],
      );
      const model = JSON.parse(out);
      expect(model.schema).toBe('chrome-cdp-ex.responsive-audit.v1');
      expect(model.verdict).toBe('pass');
      expect(sizes[0]).toBe('800x600');
      expect(sizes.at(-1)).toBe('1042x632');
      expect(current).toEqual({ w: 1042, h: 632 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#237 responsive-audit restores the original viewport after a screenshot timeout', async () => {
    const sizes = [];
    let current = { w: 1042, h: 632 };
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-responsive-timeout-'));
    const session = T.createSessionState({
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
      sessionId: 'sid',
      logPath: join(tmp, 'session.jsonl'),
      screenshotDir: join(tmp, 'shots'),
    });
    T.resetScreenshotTier();
    const cdp = {
      send(method, params = {}) {
        if (method === 'Emulation.setDeviceMetricsOverride') {
          sizes.push(`${params.width}x${params.height}`);
          current = { w: params.width, h: params.height };
          return Promise.resolve({});
        }
        if (method === 'Page.captureScreenshot') {
          throw new Error('Timeout: Page.captureScreenshot');
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('{w:window.innerWidth') && expr.includes('innerHeight')) {
            return Promise.resolve({ result: { value: JSON.stringify(current) } });
          }
          if (expr.includes('document.title')) {
            return Promise.resolve({
              result: { value: JSON.stringify({ title: 'Example Domain', url: 'https://example.com/', contentType: 'text/html' }) },
            });
          }
          if (expr.includes('overflowX') || expr.includes('clippedControls')) {
            return Promise.resolve({
              result: {
                value: JSON.stringify({
                  url: 'https://example.com/',
                  title: 'Example Domain',
                  viewport: `${current.w}x${current.h}`,
                  overflowX: false,
                  controlCount: 0,
                  controls: [],
                  clippedControls: [],
                  overlaps: [],
                }),
              },
            });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        return Promise.resolve({});
      },
      waitForEvent() {
        return { promise: Promise.reject(new Error('timeout')), cancel() {} };
      },
    };
    try {
      await expect(T.responsiveAuditStr(
        cdp,
        'sid',
        session,
        '1D3669785EAC5A1A211792636BAE8A07',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        ['--viewport', '800x600'],
      )).rejects.toThrow(/Screenshot failed: all methods timed out|Timeout: Page\.captureScreenshot/);
      expect(sizes[0]).toBe('800x600');
      expect(sizes.at(-1)).toBe('1042x632');
      expect(current).toEqual({ w: 1042, h: 632 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#238 click --qa on a Chrome PDF viewer emits pdf-viewer.v1, not pass/populated', () => {
    const dump = T.formatPdfViewerOutput(PDF_PAGE, { targetPrefix: PDF_PREFIX });
    const result = T.createActionResult({
      action: 'click',
      target: {
        targetId: PDF_TARGET_ID,
        input: 'body',
        label: 'body',
        page: PDF_PAGE,
      },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 5361 },
      effects: {
        page: PDF_PAGE,
        pageHealth: {
          status: 'populated',
          isBlank: false,
          confidence: 'high',
          evidence: {
            url: PDF_PAGE.url,
            title: '',
            visibleTextLength: 0,
            elementCount: 4,
            visibleControlCount: 0,
            bodyRect: { width: 800, height: 0 },
            changed: true,
          },
        },
        domDiff: dump,
        console: [],
        network: [],
      },
    });

    const text = T.formatActionResultOutput(result, { qa: true });
    expect(text).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(text).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(text).not.toMatch(/QA summary: pass/);
    expect(text).not.toMatch(/Page health: populated/);
    expect(text).not.toMatch(/Changed: changed/);
    expect(text).not.toContain('<target>');
    expect(text).not.toMatch(/cdp perceive /);

    const parsed = JSON.parse(T.formatActionResultOutput(result, { qa: true, format: 'json' }));
    expect(parsed.schema).toBe('chrome-cdp-ex.pdf-viewer.v1');
    expect(parsed.nextCommand).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(parsed).not.toMatchObject({ ok: true });
    expect(parsed.summary?.pageHealth?.status).not.toBe('populated');
  });

  it('#239 action PDF Next interpolates the prefix and misses do not recommend perceive', async () => {
    expect(T.actionObservationPerceiveOpts(PDF_TARGET_ID)).toMatchObject({ targetPrefix: PDF_PREFIX });
    expect(T.actionObservationPerceiveOpts(PDF_TARGET_ID, { sinceAction: true }).targetPrefix).toBe(PDF_PREFIX);

    const printed = T.formatPdfViewerOutput(PDF_PAGE, { targetPrefix: PDF_PREFIX });
    expect(printed).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(printed).not.toContain('<target>');

    const cdp = {
      send(method) {
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({
            result: {
              value: JSON.stringify({
                title: '',
                url: PDF_PAGE.url,
                contentType: 'application/pdf',
                vw: 800,
                vh: 600,
                scrollY: 0,
                scrollMax: 0,
                counts: {},
                focused: '',
                layoutMap: {},
                styleHints: {},
                cursorInteractives: [],
                visibleControls: [],
                visibleControlsTruncated: false,
                cardWindows: [],
              }),
            },
          });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({ nodes: [] });
        }
        return Promise.resolve({});
      },
    };
    const observed = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      { output: null },
      T.actionObservationPerceiveOpts(PDF_TARGET_ID),
    );
    expect(observed).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(observed).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(observed).not.toContain('<target>');

    const hit = T.formatActionResultOutput(T.createActionResult({
      action: 'viewport',
      target: { targetId: PDF_TARGET_ID, input: '1042x632', resolvedBy: 'viewport', page: PDF_PAGE },
      dispatch: { ok: true, method: 'viewport' },
      settle: { ok: true, durationMs: 947 },
      effects: { page: PDF_PAGE, domDiff: observed, console: [], network: [] },
    }), { dispatchText: observed });
    expect(hit).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(hit).not.toContain('<target>');

    const miss = T.formatActionFailure(new Error('Element not found: a'), {
      action: 'click',
      target: {
        targetId: PDF_TARGET_ID,
        input: 'a',
        page: PDF_PAGE,
      },
    });
    expect(miss).toMatch(/Action failure: selector/);
    expect(miss).toContain(`Next: cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(miss).not.toMatch(/cdp perceive /);
    expect(miss).not.toContain('<target>');
    expect(miss).not.toContain(PDF_TARGET_ID);

    const htmlMiss = T.formatActionFailure(new Error('Element not found: a'), {
      action: 'click',
      target: {
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        input: 'a',
        page: { title: 'Example Domain', url: 'https://example.com/', contentType: 'text/html' },
      },
    });
    expect(htmlMiss).toMatch(/Next: cdp perceive /);
    expect(htmlMiss).not.toMatch(/document\.contentType/);
  });
});

describe('issues #241-#243 open contracts', () => {
  const PDF_TARGET_ID = '9FAD7C71E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = '9FAD7C71';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };

  function pdfPageCdp() {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({ result: { value: JSON.stringify(PDF_PAGE) } });
          }
          if (expr.includes('outerHTML')) {
            return Promise.resolve({
              result: {
                value: JSON.stringify({
                  ok: true,
                  root: 'document',
                  html: '<html><head><link rel="stylesheet" href="chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/pdf_embedder.css"></head><body></body></html>',
                }),
              },
            });
          }
          if (expr.includes('{w:window.innerWidth') && expr.includes('innerHeight')) {
            return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Page.captureScreenshot') {
          throw new Error('screenshot should not run on pdf-viewer qa');
        }
        if (method === 'Accessibility.getFullAXTree') {
          throw new Error('ax should not run on pdf-viewer qa');
        }
        if (method === 'Emulation.setDeviceMetricsOverride') {
          throw new Error('viewport should not change on pdf-viewer qa');
        }
        return Promise.resolve({});
      },
    };
  }

  it('#241 qa on a Chrome PDF viewer emits pdf-viewer.v1, not Verdict:pass / perceive', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-qa-pdf-'));
    const session = T.createSessionState({
      targetId: PDF_TARGET_ID,
      sessionId: 'sid',
      logPath: join(tmp, 'session.jsonl'),
      screenshotDir: join(tmp, 'shots'),
    });
    const cdp = pdfPageCdp();
    const ctx = {
      cdp,
      sid: 'sid',
      session,
      targetId: PDF_TARGET_ID,
      consoleBuf: new T.RingBuffer(8),
      exceptionBuf: new T.RingBuffer(8),
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: {},
      actionFeedback: async () => '',
    };
    try {
      const text = await T.qaPageStr(ctx, []);
      expect(text).toContain('chrome-cdp-ex.pdf-viewer.v1');
      expect(text).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
      expect(text).not.toMatch(/Verdict: pass/);
      expect(text).not.toMatch(/cdp perceive /);
      expect(text).not.toContain('chrome-extension://');
      expect(cdp.calls.some(call => call.method === 'Page.captureScreenshot')).toBe(false);
      expect(cdp.calls.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(false);
      expect(cdp.calls.some(call => call.method === 'Emulation.setDeviceMetricsOverride')).toBe(false);

      const parsed = JSON.parse(await T.qaPageStr(ctx, ['--format', 'json']));
      expect(parsed.schema).toBe('chrome-cdp-ex.pdf-viewer.v1');
      expect(parsed.nextCommand).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
      expect(parsed.verdict).not.toBe('pass');
      expect(JSON.stringify(parsed)).not.toMatch(/cdp perceive /);
      expect(parsed.nextSteps || []).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/cdp perceive /),
      ]));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#242 html on a Chrome PDF viewer emits pdf-viewer.v1, not the empty embedder shell', async () => {
    const cdp = pdfPageCdp();
    await expect(T.htmlStr(cdp, 'sid', [], { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);
    await expect(T.htmlStr(cdp, 'sid', ['--auto'], { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/cdp eval 9FAD7C71 "document\.contentType"/);
    await expect(T.htmlStr(cdp, 'sid', ['h1'], { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/pdf-viewer\.v1/);
    expect(cdp.calls.some(call => String(call.params?.expression || '').includes('outerHTML'))).toBe(false);

    let thrown;
    try {
      await T.htmlStr(cdp, 'sid', ['h1'], { targetPrefix: PDF_PREFIX });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('pdf_viewer');
    expect(thrown.message).not.toContain('<target>');
    expect(thrown.message).not.toContain('chrome-extension://');
    expect(thrown.message).not.toMatch(/Kind: unknown/);
    const recovery = T.buildCliErrorRecovery(thrown.message, {
      cmd: 'html',
      targetPrefix: PDF_PREFIX,
      err: thrown,
    });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(recovery.run).not.toMatch(/cdp status /);

    const htmlPage = {
      send(method, params = {}) {
        if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
        const expr = String(params.expression || '');
        if (expr.includes('contentType') || expr.includes('document.title')) {
          return Promise.resolve({
            result: {
              value: JSON.stringify({
                title: 'Example Domain',
                url: 'https://example.com/',
                contentType: 'text/html',
              }),
            },
          });
        }
        return Promise.resolve({
          result: { value: JSON.stringify({ ok: false, root: 'document', selector: 'h1' }) },
        });
      },
    };
    await expect(T.htmlStr(htmlPage, 'sid', ['h1'], { targetPrefix: '1D366978' }))
      .rejects.toThrow(/cdp eval 1D366978 /);
    const htmlMiss = await T.htmlStr(htmlPage, 'sid', ['h1'], { targetPrefix: '1D366978' })
      .then(() => {
        throw new Error('expected html selector miss');
      }, error => error);
    expect(htmlMiss.message).not.toContain('<target>');
  });

  it('#243 cookiedel of a dotted-domain cookie deletes by domain/path or fails closed', async () => {
    expect(T.cookieDeleteParams(
      { name: 'picky10x', domain: '.huggingface.co', path: '/' },
      'https://huggingface.co/',
    )).toEqual({ name: 'picky10x', domain: '.huggingface.co', path: '/' });
    expect(T.cookieDeleteParams(
      { name: 'picky10x', domain: '.huggingface.co', path: '/' },
      'https://huggingface.co/',
    )).not.toHaveProperty('url');

    const jar = [{ name: 'picky10x', value: 'x', domain: '.huggingface.co', path: '/', secure: true }];
    const calls = [];
    const cdp = {
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: 'https://huggingface.co/' } });
        }
        if (method === 'Network.getCookies') {
          return Promise.resolve({ cookies: jar.map(cookie => ({ ...cookie })) });
        }
        if (method === 'Network.deleteCookies') {
          const idx = jar.findIndex(cookie => cookie.name === params.name
            && cookie.domain === params.domain
            && cookie.path === params.path);
          if (idx !== -1) jar.splice(idx, 1);
          return Promise.resolve({});
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const deleted = await T.cookieDelStr(cdp, 'sid', 'picky10x');
    expect(deleted).toBe('Cookie deleted: picky10x');
    expect(jar).toEqual([]);
    const del = calls.find(call => call.method === 'Network.deleteCookies');
    expect(del.params).toEqual({ name: 'picky10x', domain: '.huggingface.co', path: '/' });
    expect(del.params).not.toHaveProperty('url');
    expect(calls.some(call => call.method === 'Runtime.evaluate')).toBe(false);

    const leftover = [{ name: 'picky10x', value: 'x', domain: '.huggingface.co', path: '/' }];
    const leftoverCalls = [];
    const leftoverCdp = {
      send(method, params = {}) {
        leftoverCalls.push({ method, params });
        if (method === 'Network.getCookies') {
          return Promise.resolve({ cookies: leftover.map(cookie => ({ ...cookie })) });
        }
        if (method === 'Network.deleteCookies') return Promise.resolve({});
        throw new Error(`unexpected ${method}`);
      },
    };
    await expect(T.cookieDelStr(leftoverCdp, 'sid', 'picky10x'))
      .rejects.toThrow(/Cookie still present: picky10x/);
    expect(leftoverCalls.some(call => call.method === 'Network.deleteCookies')).toBe(true);
    const leftoverRecovery = T.buildCliErrorRecovery('Cookie still present: picky10x', {
      cmd: 'cookiedel',
      targetPrefix: '6914C171',
    });
    expect(leftoverRecovery.kind).toBe('usage');
    expect(leftoverRecovery.run).toBe('cdp cookies 6914C171');
    const leftoverFormatted = T.formatCliError(new Error('Cookie still present: picky10x'), {
      cmd: 'cookiedel',
      targetPrefix: '6914C171',
    });
    expect(leftoverFormatted).toMatch(/Kind: usage/);
    expect(leftoverFormatted).not.toMatch(/Cookie deleted/);

    const hostJar = [{ name: 'picky10y', value: 'y', domain: 'huggingface.co', path: '/' }];
    const hostCdp = {
      send(method, params = {}) {
        if (method === 'Network.getCookies') {
          return Promise.resolve({ cookies: hostJar.map(cookie => ({ ...cookie })) });
        }
        if (method === 'Network.deleteCookies') {
          const idx = hostJar.findIndex(cookie => cookie.name === params.name
            && cookie.domain === params.domain);
          if (idx !== -1) hostJar.splice(idx, 1);
          return Promise.resolve({});
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    await expect(T.cookieDelStr(hostCdp, 'sid', 'picky10y')).resolves.toBe('Cookie deleted: picky10y');
    expect(hostJar).toEqual([]);
  });
});

describe('issues #245-#248 open contracts', () => {
  const PDF_TARGET_ID = '9FAD7C71E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = '9FAD7C71';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };

  function pdfPageCdp() {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({ result: { value: JSON.stringify(PDF_PAGE) } });
          }
          if (expr.includes('getComputedStyle') || expr.includes('keep')) {
            throw new Error('styles should not read embedder computed styles on pdf-viewer');
          }
          if (expr.includes('{w:window.innerWidth') && expr.includes('innerHeight')) {
            return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Page.captureScreenshot') {
          throw new Error('screenshot should not run on pdf-viewer visual-check');
        }
        if (method === 'Accessibility.getFullAXTree') {
          throw new Error('ax should not run on pdf-viewer snap');
        }
        if (method === 'Emulation.setDeviceMetricsOverride') {
          throw new Error('viewport should not change on pdf-viewer visual-check');
        }
        return Promise.resolve({});
      },
    };
  }

  it('#245 visual-check on a Chrome PDF viewer emits pdf-viewer.v1 without screenshots or leftover viewport', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-visual-pdf-'));
    const session = T.createSessionState({
      targetId: PDF_TARGET_ID,
      sessionId: 'sid',
      logPath: join(tmp, 'session.jsonl'),
      screenshotDir: join(tmp, 'shots'),
    });
    const cdp = pdfPageCdp();
    try {
      await expect(T.responsiveAuditStr(
        cdp,
        'sid',
        session,
        PDF_TARGET_ID,
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        ['--viewport', '800x600'],
      )).rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);

      let thrown;
      try {
        await T.responsiveAuditStr(
          cdp,
          'sid',
          session,
          PDF_TARGET_ID,
          new T.RingBuffer(8),
          new T.RingBuffer(8),
          ['--viewport', '800x600'],
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown?.code).toBe('pdf_viewer');
      expect(thrown.message).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
      expect(thrown.message).not.toMatch(/cdp shot /);
      expect(thrown.message).not.toMatch(/cdp perceive /);
      expect(thrown.message).not.toMatch(/Use `perceive`/);
      expect(cdp.calls.some(call => call.method === 'Page.captureScreenshot')).toBe(false);
      expect(cdp.calls.some(call => call.method === 'Emulation.setDeviceMetricsOverride')).toBe(false);

      const recovery = T.buildCliErrorRecovery(thrown.message, {
        cmd: 'visual-check',
        targetPrefix: PDF_PREFIX,
        err: thrown,
      });
      expect(recovery.kind).toBe('pdf-viewer');
      expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
      expect(recovery.run).not.toMatch(/cdp shot /);
      expect(recovery.run).not.toMatch(/cdp perceive /);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#246 snap on a Chrome PDF viewer emits pdf-viewer.v1, not an empty tree plus perceive', async () => {
    const cdp = pdfPageCdp();
    await expect(T.snapshotStr(cdp, 'sid', true, { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);
    await expect(T.snapshotStr(cdp, 'sid', false, { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/cdp eval 9FAD7C71 "document\.contentType"/);

    let thrown;
    try {
      await T.snapshotStr(cdp, 'sid', true, { targetPrefix: PDF_PREFIX });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('pdf_viewer');
    expect(thrown.message).not.toMatch(/Use `perceive`/);
    expect(thrown.message).not.toMatch(/recommended starting command/);
    expect(cdp.calls.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(false);

    const recovery = T.buildCliErrorRecovery(thrown.message, {
      cmd: 'snap',
      targetPrefix: PDF_PREFIX,
      err: thrown,
    });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(recovery.run).not.toMatch(/cdp perceive /);
  });

  it('#247 styles on a Chrome PDF viewer emits pdf-viewer.v1, not embedder BODY/HTML styles', async () => {
    const cdp = pdfPageCdp();
    await expect(T.stylesStr(cdp, 'sid', ['body'], { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);
    await expect(T.stylesStr(cdp, 'sid', ['html'], { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/cdp eval 9FAD7C71 "document\.contentType"/);

    let thrown;
    try {
      await T.stylesStr(cdp, 'sid', ['body'], { targetPrefix: PDF_PREFIX });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('pdf_viewer');
    expect(thrown.message).not.toContain('Times New Roman');
    expect(thrown.message).not.toContain('rgb(40, 40, 40)');
    expect(thrown.message).not.toMatch(/<BODY>/);
    expect(cdp.calls.some(call => String(call.params?.expression || '').includes('getComputedStyle'))).toBe(false);

    const recovery = T.buildCliErrorRecovery(thrown.message, {
      cmd: 'styles',
      targetPrefix: PDF_PREFIX,
      err: thrown,
    });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);

    const htmlPage = {
      send(method, params = {}) {
        if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
        const expr = String(params.expression || '');
        if (expr.includes('contentType') || expr.includes('document.title')) {
          return Promise.resolve({
            result: {
              value: JSON.stringify({
                title: 'Example Domain',
                url: 'https://example.com/',
                contentType: 'text/html',
              }),
            },
          });
        }
        return Promise.resolve({
          result: { value: JSON.stringify({ ok: false, root: 'document', selector: 'h1' }) },
        });
      },
    };
    const miss = await T.stylesStr(htmlPage, 'sid', ['h1'], { targetPrefix: '1D366978' })
      .then(() => {
        throw new Error('expected styles selector miss');
      }, error => error);
    expect(miss.message).toContain('cdp eval 1D366978');
    expect(miss.message).not.toContain('<target>');
  });

  it('#248 fill does not claim Filled/changed when the live textarea value stays empty', async () => {
    const calls = [];
    const cdp = {
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('cdpFillLiveValue')) {
            return Promise.resolve({
              result: { value: { ok: true, tag: 'TEXTAREA', value: '', textContent: '' } },
            });
          }
          return Promise.resolve({
            result: { value: { ok: true, fillable: true, tag: 'TEXTAREA' } },
          });
        }
        if (method === 'Input.insertText') return Promise.resolve({});
        if (method === 'DOM.enable') return Promise.resolve({});
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 42 });
        if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'obj-textarea' } });
        if (method === 'Runtime.callFunctionOn') {
          if (!params.arguments) {
            return Promise.resolve({ result: { value: { ok: true, fillable: true, tag: 'TEXTAREA' } } });
          }
          return Promise.resolve({ result: { value: { tag: 'TEXTAREA', value: '' } } });
        }
        return Promise.resolve({});
      },
    };

    await expect(T.fillStr(cdp, 'sid', '#chat-assistant-textarea', 'picky11-no-submit', new Map()))
      .rejects.toThrow(/did not accept|live value is still empty/);
    expect(calls.some(call => call.method === 'Input.insertText')).toBe(true);

    let thrown;
    try {
      await T.fillStr(cdp, 'sid', '#chat-assistant-textarea', 'picky11-no-submit', new Map());
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown?.message || '')).not.toMatch(/^Filled /);
    expect(String(thrown?.message || '')).not.toContain('Filled <TEXTAREA>');

    const failure = T.classifyActionFailure(thrown, {
      action: 'fill',
      target: { targetId: '77C5B4F8DEADBEEF', input: '#chat-assistant-textarea' },
    });
    expect(failure.kind).toBe('fill-no-change');
    expect(failure.nextCommand).toContain('cdp eval 77C5B4F8');
    expect(failure.nextCommand).not.toMatch(/cdp perceive /);

    const formatted = T.formatActionFailure(thrown, {
      action: 'fill',
      target: { targetId: '77C5B4F8DEADBEEF', input: '#chat-assistant-textarea' },
    });
    expect(formatted).not.toMatch(/^Filled /m);
    expect(formatted).toMatch(/Action failure: fill-no-change/);
    expect(formatted).not.toMatch(/Outcome: changed/);

    expect(T.fillLiveValueAccepted({ ok: true, value: '', textContent: '' }, 'picky11-no-submit')).toBe(false);
    expect(T.fillLiveValueAccepted({ ok: true, value: 'picky11-control', textContent: '' }, 'picky11-control')).toBe(true);
  });

  it('#248 fill still reports Filled when the live node actually holds the value', async () => {
    const cdp = {
      send(method, params = {}) {
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('cdpFillLiveValue')) {
            return Promise.resolve({
              result: { value: { ok: true, tag: 'INPUT', value: 'picky11-control', textContent: '' } },
            });
          }
          return Promise.resolve({ result: { value: { ok: true, tag: 'INPUT' } } });
        }
        if (method === 'Input.insertText') return Promise.resolve({});
        if (method === 'Runtime.callFunctionOn') {
          throw new Error('native setter should not run when insertText stuck');
        }
        return Promise.resolve({});
      },
    };
    const out = await T.fillStr(cdp, 'sid', '#picky11in', 'picky11-control', new Map());
    expect(out).toContain('Filled <INPUT>');
    expect(out).toContain('picky11-control');
  });
});

describe('issues #250-#253 open contracts', () => {
  const PDF_TARGET_ID = '9FAD7C71E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = '9FAD7C71';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };

  function pdfPageCdp() {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({ result: { value: JSON.stringify(PDF_PAGE) } });
          }
          if (expr.includes('getComputedStyle') || expr.includes('querySelectorAll')) {
            throw new Error('should not inspect embedder DOM on pdf-viewer');
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'CSS.getComputedStyleForNode' || method === 'CSS.getMatchedStylesForNode') {
          throw new Error('cascade should not read embedder computed styles on pdf-viewer');
        }
        if (method === 'DOM.getDocument' || method === 'DOM.querySelector') {
          throw new Error('cascade should not query embedder DOM on pdf-viewer');
        }
        return Promise.resolve({});
      },
    };
  }

  it('#250 perceive --qa/--summary and summary on a Chrome PDF viewer emit pdf-viewer.v1', async () => {
    const emptyBuffer = { all: () => [] };
    const handler = T.createPerceiveCommandHandler({
      cdp: pdfPageCdp(),
      sessionId: 'sid',
      targetId: PDF_TARGET_ID,
      session: { lastAction: null },
      consoleBuf: emptyBuffer,
      exceptionBuf: emptyBuffer,
      netReqBuf: emptyBuffer,
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: {},
      ops: {
        readPerceiveTargetMetadata: async () => ({ targetId: PDF_TARGET_ID, url: PDF_PAGE.url }),
        readPerceiveDocumentState: async () => ({ url: PDF_PAGE.url, readyState: 'complete' }),
        pageInfoModel: async () => PDF_PAGE,
        collectPageHealth: async () => {
          throw new Error('qa health should not run on pdf-viewer perceive');
        },
        perceiveText: async () => {
          throw new Error('perceive tree should not run on pdf-viewer qa');
        },
      },
    });

    for (const args of [['--qa'], ['--summary']]) {
      const text = (await handler({ args })).value;
      expect(text).toContain('chrome-cdp-ex.pdf-viewer.v1');
      expect(text).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
      expect(text).not.toMatch(/QA summary:/);
      expect(text).not.toMatch(/Page health: indeterminate/);
      expect(text).not.toMatch(/cdp report /);
      expect(text).not.toContain('<target>');
    }

    const parsed = JSON.parse((await handler({ args: ['--qa', '--format', 'json'] })).value);
    expect(parsed.schema).toBe('chrome-cdp-ex.pdf-viewer.v1');
    expect(parsed.nextCommand).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(parsed.summary?.schema).not.toBe('chrome-cdp-ex.qa-summary.v1');
    expect(JSON.stringify(parsed)).not.toMatch(/cdp report /);
    expect(JSON.stringify(parsed)).not.toContain('<target>');

    const htmlHandler = T.createPerceiveCommandHandler({
      cdp: { send() { throw new Error('unexpected CDP command'); } },
      sessionId: 'sid',
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
      session: { lastAction: null },
      consoleBuf: emptyBuffer,
      exceptionBuf: emptyBuffer,
      netReqBuf: emptyBuffer,
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: {},
      ops: {
        readPerceiveTargetMetadata: async () => ({
          targetId: '1D3669785EAC5A1A211792636BAE8A07',
          url: 'https://example.com/',
        }),
        readPerceiveDocumentState: async () => ({ url: 'https://example.com/', readyState: 'complete' }),
        pageInfoModel: async () => ({
          title: 'Example Domain',
          url: 'https://example.com/',
          contentType: 'text/html',
        }),
        collectPageHealth: async () => ({
          status: 'populated',
          isBlank: false,
          evidence: { url: 'https://example.com/', title: 'Example Domain' },
        }),
        perceiveText: async () => 'Example Domain body',
      },
    });
    const htmlQa = (await htmlHandler({ args: ['--qa'] })).value;
    expect(htmlQa).toMatch(/QA summary: pass/);
    expect(htmlQa).toContain('Example Domain');
    expect(htmlQa).not.toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(htmlQa).toContain('cdp report 1D366978');

    const cdp = pdfPageCdp();
    await expect(T.summaryStr(cdp, 'sid', new T.RingBuffer(8), new T.RingBuffer(8), { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);
    await expect(T.summaryModel(cdp, 'sid', new T.RingBuffer(8), new T.RingBuffer(8), { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/cdp eval 9FAD7C71 "document\.contentType"/);

    let thrown;
    try {
      await T.summaryStr(cdp, 'sid', new T.RingBuffer(8), new T.RingBuffer(8), { targetPrefix: PDF_PREFIX });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('pdf_viewer');
    expect(thrown.message).not.toContain('<target>');
    expect(thrown.message).not.toMatch(/Interactive: none/);
    expect(thrown.message).not.toMatch(/cdp report /);
    const recovery = T.buildCliErrorRecovery(thrown.message, {
      cmd: 'summary',
      targetPrefix: PDF_PREFIX,
      err: thrown,
    });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
  });

  it('#251 cascade on a Chrome PDF viewer emits pdf-viewer.v1, not embedder BODY styles', async () => {
    const cdp = pdfPageCdp();
    await expect(T.cascadeStr(cdp, 'sid', 'body', 'color', new Map(), null, { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);
    await expect(T.cascadeStr(cdp, 'sid', 'body', null, new Map(), null, {
      format: 'json',
      targetPrefix: PDF_PREFIX,
    })).rejects.toThrow(/cdp eval 9FAD7C71 "document\.contentType"/);

    let thrown;
    try {
      await T.cascadeStr(cdp, 'sid', 'body', 'color', new Map(), null, { targetPrefix: PDF_PREFIX });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('pdf_viewer');
    expect(thrown.message).not.toContain('rgb(0, 0, 0)');
    expect(thrown.message).not.toContain('<target>');
    expect(cdp.calls.some(call => call.method === 'CSS.getComputedStyleForNode')).toBe(false);
    expect(cdp.calls.some(call => call.method === 'DOM.querySelector')).toBe(false);

    const recovery = T.buildCliErrorRecovery(thrown.message, {
      cmd: 'cascade',
      targetPrefix: PDF_PREFIX,
      err: thrown,
    });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
  });

  it('#252 fullshot clip timeout does not poison viewport shot or claim captureScreenshot unavailable', async () => {
    expect(T.FULLSHOT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(T.FULLSHOT_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    expect(T.screenshotCaptureUsesSessionTier({ format: 'png' })).toBe(true);
    expect(T.screenshotCaptureUsesSessionTier({
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1042, height: 4000, scale: 1 },
    })).toBe(false);
    expect(T.fullshotFitsViewport({ width: 1042, height: 632 }, { w: 1042, h: 632 })).toBe(true);
    expect(T.fullshotFitsViewport({ width: 1042, height: 4000 }, { w: 1042, h: 632 })).toBe(false);

    T.resetScreenshotTier();
    const clipCdp = {
      calls: [],
      send(method, params = {}, sessionId, timeout) {
        this.calls.push({ method, params, sessionId, timeout });
        if (method === 'Page.captureScreenshot') {
          throw new Error('Timeout: Page.captureScreenshot');
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.reject(new Error('timeout')), cancel() {} };
      },
    };
    await expect(T.captureScreenshot(clipCdp, 'sid', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1042, height: 4000, scale: 1 },
    })).rejects.toThrow(/all methods timed out|Timeout: Page\.captureScreenshot/);
    expect(T.getScreenshotTier()).toBe(1);

    const tmp = mkdtempSync(join(tmpdir(), 'cdp-fullshot-'));
    try {
      T.resetScreenshotTier();
      const viewportCdp = {
        calls: [],
        send(method, params = {}, sessionId, timeout) {
          this.calls.push({ method, params, sessionId, timeout });
          if (method === 'Runtime.evaluate') {
            const expr = String(params.expression || '');
            if (expr.includes('innerWidth')) {
              return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
            }
            return Promise.resolve({ result: { value: 1 } });
          }
          if (method === 'Page.getLayoutMetrics') {
            return Promise.resolve({ cssContentSize: { width: 1042, height: 632 } });
          }
          if (method === 'Page.captureScreenshot') {
            expect(params.captureBeyondViewport).not.toBe(true);
            expect(params.clip).toBeUndefined();
            return Promise.resolve({ data: Buffer.from('PNG').toString('base64') });
          }
          return Promise.resolve({});
        },
        onEvent() { return () => {}; },
        waitForEvent() {
          return { promise: Promise.reject(new Error('timeout')), cancel() {} };
        },
      };
      const out = await T.fullshotStr(viewportCdp, 'sid', join(tmp, 'full.png'), '1D3669785EAC5A1A211792636BAE8A07');
      expect(out).toMatch(/1042x632/);
      expect(out).not.toMatch(/not available/);
      expect(T.getScreenshotTier()).toBe(1);

      T.resetScreenshotTier();
      const tallCdp = {
        calls: [],
        send(method, params = {}, sessionId, timeout) {
          this.calls.push({ method, params, sessionId, timeout });
          if (method === 'Runtime.evaluate') {
            const expr = String(params.expression || '');
            if (expr.includes('innerWidth')) {
              return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
            }
            return Promise.resolve({ result: { value: 1 } });
          }
          if (method === 'Page.getLayoutMetrics') {
            return Promise.resolve({ cssContentSize: { width: 1042, height: 4000 } });
          }
          if (method === 'Page.captureScreenshot') {
            throw new Error('Timeout: Page.captureScreenshot');
          }
          return Promise.resolve({});
        },
        onEvent() { return () => {}; },
        waitForEvent() {
          return { promise: Promise.reject(new Error('timeout')), cancel() {} };
        },
      };
      await expect(T.fullshotStr(tallCdp, 'sid', join(tmp, 'tall.png'), '1D3669785EAC5A1A211792636BAE8A07'))
        .rejects.toThrow(/full-page capture timed out|untrusted/);
      const captureCall = tallCdp.calls.find(call => call.method === 'Page.captureScreenshot');
      expect(captureCall.params.captureBeyondViewport).toBe(true);
      expect(captureCall.timeout).toBe(T.FULLSHOT_TIMEOUT_MS);
      expect(T.getScreenshotTier()).toBe(1);

      const shotCdp = {
        calls: [],
        send(method, params = {}) {
          this.calls.push({ method, params });
          if (method === 'Page.captureScreenshot') {
            return Promise.resolve({ data: 'viewport-ok' });
          }
          return Promise.resolve({});
        },
        onEvent() { return () => {}; },
        waitForEvent() {
          return { promise: Promise.reject(new Error('timeout')), cancel() {} };
        },
      };
      const shot = await T.captureScreenshot(shotCdp, 'sid', { format: 'png' });
      expect(shot.data).toBe('viewport-ok');
      expect(shot.fallback).toBe(false);
      expect(shotCdp.calls[0].params.fromSurface).toBeUndefined();
      expect(T.getScreenshotTier()).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    expect(T.diffShotScreenshotCaptureOptions()).toMatchObject({
      failFastOnTimeout: true,
      skipSanityRetry: true,
    });
  });

  it('#253 realistic click bounds mouse compositor-ack and still follows an <a href>', async () => {
    const events = [];
    await expect(T.dispatchClick({
      send(method, params = {}, _sessionId, timeoutMs) {
        if (method === 'Input.dispatchMouseEvent') {
          events.push({ ...params, timeoutMs });
          return Promise.reject(new Error('Timeout: Input.dispatchMouseEvent'));
        }
        return Promise.resolve({});
      },
    }, 'sid', 40, 20)).rejects.toThrow(/received no mousedown\/click events/);
    expect(events).toHaveLength(3);
    expect(events[0].timeoutMs).toBe(T.HOVER_MOUSE_ACK_TIMEOUT_MS);
    expect(events[1].timeoutMs).toBe(T.CLICK_MOUSE_ACK_TIMEOUT_MS);
    expect(events[2].timeoutMs).toBe(T.CLICK_MOUSE_ACK_TIMEOUT_MS);
    expect(events[0]).toMatchObject({ type: 'mouseMoved', button: 'none', buttons: 0, pointerType: 'mouse' });
    expect(events[1]).toMatchObject({ type: 'mousePressed', button: 'left', buttons: 1, pointerType: 'mouse' });
    expect(events[2]).toMatchObject({ type: 'mouseReleased', button: 'left', buttons: 0, pointerType: 'mouse' });

    let href = 'https://example.com/';
    let probeSeen = [];
    const cdp = {
      send(method, params = {}, _sessionId, timeout) {
        const src = method === 'Runtime.evaluate'
          ? String(params.expression || '')
          : String(params.functionDeclaration || '');
        if (src.includes('__chromeCdpExClickProbe')) {
          if (src.includes('installed: true')) {
            probeSeen = [];
            return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: 'top' } } });
          }
          return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, seen: probeSeen.slice() } } });
        }
        if (method === 'Runtime.evaluate') {
          if (String(params.expression) === 'location.href') {
            return Promise.resolve({ result: { value: href } });
          }
          return Promise.resolve({
            result: {
              value: {
                ok: true,
                x: 40,
                y: 20,
                tag: 'A',
                text: 'Learn more',
                href: 'https://www.iana.org/help/example-domains',
                pageHref: 'https://example.com/',
              },
            },
          });
        }
        if (method === 'Input.dispatchMouseEvent') {
          if (params.type === 'mouseReleased') {
            href = 'https://www.iana.org/help/example-domains';
            if (!(Number(timeout) < T.CLICK_MOUSE_ACK_TIMEOUT_MS)) probeSeen.push('mousedown', 'click');
          }
          return Promise.resolve({});
        }
        return Promise.resolve({});
      },
    };
    await expect(T.clickStr(cdp, 'sid', 'a', new Map())).resolves.toBe('Clicked <A> "Learn more"');
    expect(href).toBe('https://www.iana.org/help/example-domains');
  });
});

describe('issues #255-#257 leftover contracts', () => {
  const PDF_TARGET_ID = '9FAD7C71E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = '9FAD7C71';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };
  const emptyBuffer = { all: () => [] };
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  function pdfPageCdp() {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({ result: { value: JSON.stringify(PDF_PAGE) } });
          }
          if (expr.includes('innerWidth')) {
            return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Page.captureScreenshot') {
          throw new Error('screenshot should not run on pdf-viewer fullshot');
        }
        if (method === 'Page.getLayoutMetrics') {
          throw new Error('layout metrics should not run on pdf-viewer fullshot');
        }
        if (method === 'Accessibility.getFullAXTree') {
          throw new Error('ax should not run on pdf-viewer leftover perceive');
        }
        if (method === 'DOM.getDocument' || method === 'DOM.querySelector') {
          throw new Error('scoped DOM should not run on pdf-viewer leftover perceive');
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.reject(new Error('timeout')), cancel() {} };
      },
    };
  }

  function pdfPerceiveHandler(overrides = {}) {
    return T.createPerceiveCommandHandler({
      cdp: pdfPageCdp(),
      sessionId: 'sid',
      targetId: PDF_TARGET_ID,
      session: { lastAction: null },
      consoleBuf: emptyBuffer,
      exceptionBuf: emptyBuffer,
      netReqBuf: emptyBuffer,
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: {},
      ops: {
        readPerceiveTargetMetadata: async () => ({ targetId: PDF_TARGET_ID, url: PDF_PAGE.url }),
        readPerceiveDocumentState: async () => ({ url: PDF_PAGE.url, readyState: 'complete' }),
        pageInfoModel: async () => PDF_PAGE,
        collectPageHealth: async () => {
          throw new Error('qa health should not run on pdf-viewer leftover perceive');
        },
        perceiveText: async () => {
          throw new Error('perceive tree should not run on pdf-viewer leftover flags');
        },
        perceiveModel: async () => {
          throw new Error('perceive.v1 JSON should not run on pdf-viewer leftover flags');
        },
        ...overrides.ops,
      },
      ...overrides,
    });
  }

  it('#255 leftover perceive --cards/-s/--format json on a Chrome PDF viewer emit pdf-viewer.v1', async () => {
    const handler = pdfPerceiveHandler();
    const next = `cdp eval ${PDF_PREFIX} "document.contentType"`;

    for (const args of [['--cards'], ['--cards', '--format', 'json'], ['-s', 'body'], ['--format', 'json']]) {
      const raw = (await handler({ args })).value;
      if (args.includes('json')) {
        const parsed = JSON.parse(raw);
        expect(parsed.schema).toBe('chrome-cdp-ex.pdf-viewer.v1');
        expect(parsed.nextCommand).toBe(next);
        expect(JSON.stringify(parsed)).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
        expect(JSON.stringify(parsed)).not.toMatch(/chrome-cdp-ex\.perceive\.v1/);
        expect(JSON.stringify(parsed)).not.toMatch(/cdp click .*@ref/);
        expect(JSON.stringify(parsed)).not.toMatch(/cdp perceive .*--cards/);
      } else {
        expect(raw).toContain('chrome-cdp-ex.pdf-viewer.v1');
        expect(raw).toContain(next);
        expect(raw).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
        expect(raw).not.toMatch(/Interactive: none/);
        expect(raw).not.toMatch(/cdp click /);
        expect(raw).not.toMatch(/cdp perceive .*--cards/);
      }
    }

    for (const args of [['--qa'], ['--summary']]) {
      const text = (await handler({ args })).value;
      expect(text).toContain('chrome-cdp-ex.pdf-viewer.v1');
      expect(text).toContain(next);
    }
    const qaJson = JSON.parse((await handler({ args: ['--qa', '--format', 'json'] })).value);
    expect(qaJson.schema).toBe('chrome-cdp-ex.pdf-viewer.v1');
    expect(qaJson.nextCommand).toBe(next);

    const cdp = pdfPageCdp();
    const store = { output: null };
    const cards = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { cards: true, targetPrefix: PDF_PREFIX },
    );
    expect(cards).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(cards).toContain(next);
    expect(cards).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(cdp.calls.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(false);

    const scoped = await T.perceiveStr(
      pdfPageCdp(),
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      { output: null },
      { selector: 'body', targetPrefix: PDF_PREFIX },
    );
    expect(scoped).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(scoped).not.toMatch(/Interactive: none/);

    const parsedModel = T.pdfViewerHandoffModelFromOutput(cards, PDF_PREFIX);
    expect(parsedModel).toMatchObject({
      schema: 'chrome-cdp-ex.pdf-viewer.v1',
      url: PDF_PAGE.url,
      nextCommand: next,
    });
  });

  it('#255 HTML perceive --cards still returns cards.v1', async () => {
    const handler = T.createPerceiveCommandHandler({
      cdp: { send() { throw new Error('unexpected CDP command'); } },
      sessionId: 'sid',
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
      session: { lastAction: null },
      consoleBuf: emptyBuffer,
      exceptionBuf: emptyBuffer,
      netReqBuf: emptyBuffer,
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: {},
      ops: {
        readPerceiveTargetMetadata: async () => ({
          targetId: '1D3669785EAC5A1A211792636BAE8A07',
          url: 'https://x.com/home',
        }),
        readPerceiveDocumentState: async () => ({ url: 'https://x.com/home', readyState: 'complete' }),
        pageInfoModel: async () => ({
          title: 'Home / X',
          url: 'https://x.com/home',
          contentType: 'text/html',
        }),
        perceiveText: async (_cdp, _sid, _c, _e, _refs, _store, opts) => (
          opts.format === 'json'
            ? JSON.stringify({
              schema: 'chrome-cdp-ex.cards.v1',
              cards: [{ ref: '@1', handle: '@alice', text: 'visible post' }],
              next: 'timeline virtualized; scroll and re-run --cards',
            }, null, 2)
            : 'chrome-cdp-ex.cards.v1  1 card\n@1  @alice  visible post'
        ),
      },
    });
    const text = (await handler({ args: ['--cards'] })).value;
    expect(text).toContain('chrome-cdp-ex.cards.v1');
    expect(text).toContain('@alice');
    expect(text).not.toContain('chrome-cdp-ex.pdf-viewer.v1');
    const parsed = JSON.parse((await handler({ args: ['--cards', '--format', 'json'] })).value);
    expect(parsed.schema).toBe('chrome-cdp-ex.cards.v1');
    expect(parsed.cards).toHaveLength(1);
  });

  it('#256 PDF fullshot fail-fasts as pdf-viewer.v1 without poisoning later shot', async () => {
    T.resetScreenshotTier();
    const cdp = pdfPageCdp();
    await expect(T.fullshotStr(cdp, 'sid', '/tmp/pdf-full.png', PDF_TARGET_ID))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);

    let thrown;
    try {
      await T.fullshotStr(cdp, 'sid', '/tmp/pdf-full.png', PDF_TARGET_ID);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('pdf_viewer');
    expect(thrown.message).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(thrown.message).not.toMatch(/screenshot fallback/);
    expect(thrown.message).not.toMatch(/Full-page screenshot saved/);
    expect(thrown.message).not.toMatch(/not available/);
    expect(cdp.calls.some(call => call.method === 'Page.captureScreenshot')).toBe(false);
    expect(cdp.calls.some(call => call.method === 'Page.getLayoutMetrics')).toBe(false);
    expect(T.getScreenshotTier()).toBe(1);

    const recovery = T.buildCliErrorRecovery(thrown.message, {
      cmd: 'fullshot',
      targetPrefix: PDF_PREFIX,
      err: thrown,
    });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);

    const shotCdp = {
      calls: [],
      send(method, params = {}) {
        this.calls.push({ method, params });
        if (method === 'Page.captureScreenshot') {
          return Promise.resolve({ data: 'viewport-ok' });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.reject(new Error('timeout')), cancel() {} };
      },
    };
    const shot = await T.captureScreenshot(shotCdp, 'sid', { format: 'png' });
    expect(shot.data).toBe('viewport-ok');
    expect(shot.fallback).toBe(false);
    expect(T.getScreenshotTier()).toBe(1);
  });

  it('#257 leftover perceive --cards dumps are not action settle baselines', () => {
    const cardsDump = 'chrome-cdp-ex.cards.v1  0 cards\nnext: cdp perceive 1D366978 --cards';
    expect(T.isCardsPerceiveOutput(cardsDump)).toBe(true);
    expect(T.actionDomDiffShowsChange(cardsDump)).toBe(true);

    const settled = T.actionSettleBaseline(cardsDump, T.perceiveSnapshotOpts({ cards: true }));
    expect(settled.output).toBeNull();
    expect(settled.opts.cards).toBe(false);
    expect(T.actionObservationPerceiveOpts('1D3669785EAC5A1A211792636BAE8A07', {
      sinceAction: true,
      cards: true,
    }).cards).toBe(false);

    const axTree = 'Page: Example Domain — https://example.com/\nViewport: 1042×632 | Scroll: 0/0 (0%) | Focused: none\n\n(no changes detected in AX tree)';
    expect(T.actionSettleBaseline(axTree, T.perceiveSnapshotOpts({ cursorInteractive: true, maxDepth: 8 }))).toMatchObject({
      output: axTree,
      opts: expect.objectContaining({ cards: false, cursorInteractive: true }),
    });

    const pressAfterCards = T.applyActionObservationDelta(T.createActionResult({
      action: 'press',
      target: {
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        input: 'Escape',
        resolvedBy: 'key',
        label: 'Escape',
        expectedOutcome: 'press-no-change',
      },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: T.noBaselineActionDiffText(), console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(pressAfterCards.outcome.status).toBe('no-change');
    expect(pressAfterCards.effects.diagnosis?.kind).not.toBe('dom-changed');
    const pressText = T.formatActionText(pressAfterCards);
    expect(pressText).toMatch(/Outcome: no-change/);
    expect(pressText).not.toMatch(/Outcome: changed/);
    expect(pressText).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(pressAfterCards.nextSteps.join('\n')).not.toMatch(/perceive .*--cards/);

    const liar = T.applyActionObservationDelta(T.createActionResult({
      action: 'press',
      target: {
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        input: 'Escape',
        resolvedBy: 'key',
        label: 'Escape',
        expectedOutcome: 'press-no-change',
      },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: cardsDump, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(liar.outcome.status).toBe('changed');
    expect(liar.effects.diagnosis?.kind).toBe('dom-changed');

    for (const [action, target] of [
      ['clickxy', { input: '10 10', resolvedBy: 'coordinates', label: '10,10' }],
      ['type', { input: 'hello', resolvedBy: 'focused', label: 'unfocused' }],
    ]) {
      const result = T.applyActionObservationDelta(T.createActionResult({
        action,
        target: { targetId: '1D3669785EAC5A1A211792636BAE8A07', ...target },
        dispatch: { ok: true, method: action },
        settle: { ok: true, durationMs: 80 },
        effects: { domDiff: T.noBaselineActionDiffText(), console: [], network: [], navigation: null },
      }), emptyDelta);
      expect(result.outcome.status).toBe('no-change');
      expect(result.effects.diagnosis?.kind).not.toBe('dom-changed');
      expect(result.nextSteps.join('\n')).not.toMatch(/perceive .*--cards/);
      expect(T.formatActionText(result)).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    }

    const afterDefaultPerceive = T.applyActionObservationDelta(T.createActionResult({
      action: 'press',
      target: {
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        input: 'Escape',
        resolvedBy: 'key',
        label: 'Escape',
        expectedOutcome: 'press-no-change',
      },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(afterDefaultPerceive.outcome.status).toBe('no-change');
    expect(T.formatActionText(afterDefaultPerceive)).toMatch(/Outcome: no-change/);
  });
});

describe('issue #259 leftover framed perceive settle', () => {
  const TARGET_ID = '1D3669785EAC5A1A211792636BAE8A07';
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  function pageTree({ inputValue = '', selectValue = 'a' } = {}) {
    return [
      'Page: Example Domain — https://example.com/',
      'Viewport: 1042×632 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 textbox, 1 combobox, 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Example Domain',
      `  [textbox] playground = "${inputValue}"  @1`,
      `  [combobox] = "${selectValue}"  @2`,
      '  [button] picky15  @3',
    ].join('\n');
  }

  const frameDump = [
    'Page: Example Domain — https://example.com/',
    'Frame: @f2 p15ifr child-frame https://example.com/',
    'Viewport: 200×80 | Scroll: 0/0 (0%) | Focused: none',
    'Interactive: 1 button',
    'Console: clean',
    'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
    '',
    '[WebArea] iframe',
    '  [button] inner-btn  @f2:1',
    '',
    '(no changes detected in AX tree)',
  ].join('\n');

  it('#259 leftover perceive --frame dumps are not top-level action settle baselines', () => {
    expect(T.isFramedPerceiveOutput(frameDump)).toBe(true);
    expect(T.isFramedPerceiveOutput(pageTree())).toBe(false);

    const snapshotOpts = T.perceiveSnapshotOpts({ frameRef: '@f2' });
    const topLevelFill = { input: '#p15in', resolvedBy: 'selector', label: '#p15in' };
    const topLevelSelect = { input: '#p15sel', resolvedBy: 'selector', label: '#p15sel' };
    expect(T.shouldCaptureTopLevelActionSettle(snapshotOpts, frameDump, topLevelFill)).toBe(true);

    const settled = T.actionSettleBaseline(frameDump, snapshotOpts, topLevelFill);
    expect(settled.output).toBeNull();
    expect(settled.opts.frameRef).toBeNull();
    expect(settled.opts.cards).toBe(false);

    const observeOpts = T.actionSettleObserveOpts(TARGET_ID, topLevelFill, settled.output, settled.opts);
    expect(observeOpts.frameRef).toBeNull();
    expect(observeOpts.cards).toBe(false);
    expect(observeOpts.sinceAction).toBe(true);

    const selectSettled = T.actionSettleBaseline(frameDump, snapshotOpts, topLevelSelect);
    expect(selectSettled.output).toBeNull();
    expect(T.actionSettleObserveOpts(TARGET_ID, topLevelSelect, selectSettled.output, selectSettled.opts).frameRef)
      .toBeNull();

    const frameClick = { input: '@f2:1', resolvedBy: 'frame-ref', label: 'inner-btn' };
    expect(T.shouldCaptureTopLevelActionSettle(snapshotOpts, frameDump, frameClick)).toBe(false);
    const frameSettled = T.actionSettleBaseline(frameDump, snapshotOpts, frameClick);
    expect(frameSettled.output).toBe(frameDump);
    expect(frameSettled.opts.frameRef).toBe('@f2');
    expect(T.actionSettleObserveOpts(TARGET_ID, frameClick, frameSettled.output, frameSettled.opts).frameRef)
      .toBe('@f2');

    const before = pageTree({ inputValue: '', selectValue: 'a' });
    const afterFill = pageTree({ inputValue: 'p15full', selectValue: 'a' });
    const fillDiff = T.formatPerceiveDiffOutput(before, afterFill, { mode: 'since-action' });
    expect(fillDiff).not.toMatch(/Frame: @f2/);
    expect(fillDiff).not.toMatch(/Viewport: 200×80/);
    expect(T.actionDomDiffShowsChange(fillDiff)).toBe(true);

    const fillResult = T.applyActionObservationDelta(T.createActionResult({
      action: 'fill',
      target: {
        targetId: TARGET_ID,
        input: '#p15in',
        resolvedBy: 'selector',
        label: '#p15in',
        commandArgs: ['#p15in', 'p15full'],
      },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: fillDiff, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(fillResult.outcome.status).toBe('changed');
    expect(fillResult.verdict.status).toBe('continue');
    expect(fillResult.verdict.canContinue).toBe(true);
    expect(fillResult.nextSteps.join('\n')).not.toMatch(/overlay/);
    expect(T.formatActionText(fillResult)).not.toMatch(/Frame: @f2/);

    const afterSelect = pageTree({ inputValue: 'p15full', selectValue: 'b' });
    const selectDiff = T.formatPerceiveDiffOutput(afterFill, afterSelect, { mode: 'since-action' });
    expect(selectDiff).not.toMatch(/Frame: @f2/);
    const selectResult = T.applyActionObservationDelta(T.createActionResult({
      action: 'select',
      target: {
        targetId: TARGET_ID,
        input: '#p15sel',
        resolvedBy: 'selector',
        label: '#p15sel',
        commandArgs: ['#p15sel', 'b'],
      },
      dispatch: { ok: true, method: 'select' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: selectDiff, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(selectResult.outcome.status).toBe('changed');
    expect(selectResult.verdict.canContinue).toBe(true);
    expect(selectResult.nextSteps.join('\n')).not.toMatch(/overlay/);

    const cardsDump = 'chrome-cdp-ex.cards.v1  0 cards\nnext: cdp perceive 1D366978 --cards';
    const cardsSettled = T.actionSettleBaseline(cardsDump, T.perceiveSnapshotOpts({ cards: true }));
    expect(cardsSettled.output).toBeNull();
    expect(cardsSettled.opts.cards).toBe(false);
    // #279: leftover 0-card cards is still not the settle dump, but settle must
    // recapture default AX so a later mutating click is not a no-change liar.
    expect(T.shouldCaptureTopLevelActionSettle(
      T.perceiveSnapshotOpts({ cards: true }),
      cardsDump,
      { input: 'Escape', resolvedBy: 'key', label: 'Escape' },
    )).toBe(true);
  });

  it('#259 perceive --frame still records a same-origin iframe dump for @fN:M settle', async () => {
    const store = { output: null, snapshotOpts: null };
    const refState = {};
    const cdp = {
      send(method, params = {}) {
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({
            frameTree: {
              frame: { id: 'main-frame', url: 'https://example.com/' },
              childFrames: [{
                frame: { id: 'child-frame', name: 'p15ifr', url: 'https://example.com/' },
                childFrames: [],
              }],
            },
          });
        }
        if (method === 'Page.createIsolatedWorld') {
          return Promise.resolve({ executionContextId: 42 });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({
            result: {
              value: JSON.stringify({
                title: 'Example Domain',
                url: 'https://example.com/',
                contentType: 'text/html',
                vw: 200,
                vh: 80,
                scrollY: 0,
                scrollMax: 0,
                counts: { button: 1 },
                focused: 'none',
                layoutMap: {},
                styleHints: {},
                cursorInteractives: [],
                visibleControls: [],
              }),
            },
          });
        }
        if (method === 'Accessibility.getFullAXTree') {
          expect(params.frameId).toBe('child-frame');
          return Promise.resolve({
            nodes: [
              { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'iframe' }, childIds: ['2'] },
              { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'inner-btn' }, backendDOMNodeId: 222 },
            ],
          });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'btn' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          return Promise.resolve({ result: { value: { x: 8, y: 10, w: 40, h: 16, position: '' } } });
        }
        if (method === 'DOM.getFrameOwner') {
          return Promise.resolve({ backendNodeId: 333 });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };

    const out = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { frameRef: '@f2' },
      refState,
    );
    expect(out).toContain('Frame: @f2 p15ifr');
    expect(out).toContain('Viewport: 200×80');
    expect(out).toContain('@f2:1');
    expect(store.snapshotOpts.frameRef).toBe('@f2');
    expect(refState.frameLastOutputs.get('@f2')).toContain('[button] inner-btn');

    const topLevelFill = { input: '#p15in', resolvedBy: 'selector', label: '#p15in' };
    const leftover = T.actionSettleBaseline(store.output, store.snapshotOpts, topLevelFill);
    expect(leftover.output).toBeNull();
    expect(leftover.opts.frameRef).toBeNull();
    expect(T.actionSettleObserveOpts(TARGET_ID, topLevelFill, leftover.output, leftover.opts).frameRef).toBeNull();

    const frameClick = { input: '@f2:1', resolvedBy: 'frame-ref', label: 'inner-btn' };
    const frameSettled = T.actionSettleBaseline(
      T.baselineOutputForActionTarget(refState, store.output, frameClick),
      store.snapshotOpts,
      frameClick,
    );
    expect(frameSettled.output).toContain('Frame: @f2');
    expect(frameSettled.opts.frameRef).toBe('@f2');
  });
});

describe('issue #279 leftover 0-card cards settle for click --js', () => {
  const TARGET_ID = '62E1DF195EAC5A1A211792636BAE8A07';
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  function pageMeta() {
    return JSON.stringify({
      title: 'Example Domain',
      url: 'https://example.com/',
      contentType: 'text/html',
      vw: 1042,
      vh: 632,
      scrollY: 0,
      scrollMax: 0,
      counts: { button: 1 },
      focused: 'none',
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
      visibleControls: [{
        tag: 'button',
        role: 'button',
        label: 'p21',
        clickable: true,
        rect: { x: 8, y: 80, w: 80, h: 24 },
        selector: 'button#p21btn',
        hints: { id: 'p21btn', classes: [] },
      }],
    });
  }

  function axNodes(clicks) {
    return [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example Domain' }, childIds: ['2', '3', '4'] },
      { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Example Domain' } },
      { nodeId: '3', parentId: '1', role: { value: 'button' }, name: { value: 'p21' }, backendDOMNodeId: 21 },
      { nodeId: '4', parentId: '1', role: { value: 'StaticText' }, name: { value: `clicks:${clicks}` } },
    ];
  }

  function createPicky21Page({ clicks = 6 } = {}) {
    const state = { clicks };
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'main-frame', url: 'https://example.com/' } } });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: pageMeta() } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({ nodes: axNodes(state.clicks) });
        }
        if (method === 'DOM.getDocument') {
          return Promise.resolve({ root: { nodeId: 1 } });
        }
        if (method === 'DOM.querySelector') {
          expect(params.selector).toBe('#p21btn');
          return Promise.resolve({ nodeId: 21 });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'p21-btn' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('this.click()')) {
            state.clicks += 1;
            return Promise.resolve({ result: { value: { tag: 'BUTTON', text: 'p21' } } });
          }
          return Promise.resolve({ result: { value: { connected: true, x: 8, y: 80, w: 80, h: 24 } } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
    return { cdp, state };
  }

  async function recaptureSettleBaseline(cdp, store, actionTarget, refMap = new Map(), refState = {}) {
    const baselineFromTarget = T.baselineOutputForActionTarget(refState, store.output, actionTarget);
    let settleBaseline = T.actionSettleBaseline(
      baselineFromTarget,
      store.snapshotOpts || null,
      actionTarget,
    );
    if (
      !settleBaseline.output
      && T.shouldCaptureTopLevelActionSettle(
        store.snapshotOpts,
        baselineFromTarget,
        actionTarget,
      )
    ) {
      const topLevelOpts = T.actionObservationPerceiveOpts(TARGET_ID, {
        ...(settleBaseline.opts || {}),
        frameRef: null,
      });
      const before = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        topLevelOpts,
        refState,
      );
      settleBaseline = {
        output: before,
        opts: T.perceiveSnapshotOpts(topLevelOpts),
      };
    }
    return settleBaseline;
  }

  function clickJsTarget() {
    return {
      input: '#p21btn',
      resolvedBy: 'selector-or-ref',
      label: '#p21btn',
      commandArgs: ['--js', '#p21btn'],
    };
  }

  it('#279 leftover 0-card --role feed / --cards recaptures default AX so mutating click --js is Outcome: changed', async () => {
    expect(T.parsePerceiveArgs(['--role', 'feed']).cards).toBe(true);
    expect(T.parsePerceiveArgs(['--cards']).cards).toBe(true);

    const { cdp, state } = createPicky21Page({ clicks: 6 });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const refState = {};
    const cardsOpts = T.parsePerceiveArgs(['--role', 'feed']);
    const cardsDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { ...cardsOpts, targetPrefix: '62E1DF19' },
      refState,
    );
    expect(cardsDump).toContain('chrome-cdp-ex.cards.v1');
    expect(cardsDump).toMatch(/0 cards/);
    expect(store.snapshotOpts.cards).toBe(true);
    expect(T.isCardsPerceiveOutput(store.output)).toBe(true);

    const clickTarget = clickJsTarget();
    const discarded = T.actionSettleBaseline(store.output, store.snapshotOpts, clickTarget);
    expect(discarded.output).toBeNull();
    expect(discarded.opts.cards).toBe(false);
    expect(T.shouldCaptureTopLevelActionSettle(store.snapshotOpts, store.output, clickTarget)).toBe(true);

    const observeWithoutRecapture = T.actionSettleObserveOpts(
      TARGET_ID,
      clickTarget,
      discarded.output,
      discarded.opts,
    );
    expect(observeWithoutRecapture.cards).toBe(false);

    const liar = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: TARGET_ID, ...clickTarget },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: T.noBaselineActionDiffText(), console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(liar.outcome.status).toBe('no-change');
    expect(T.formatActionText(liar)).toMatch(/No visible AX tree change/);
    expect(liar.verdict.status).toBe('investigate');

    const settleBaseline = await recaptureSettleBaseline(cdp, store, clickTarget, refMap, refState);
    expect(settleBaseline.output).toBeTruthy();
    expect(settleBaseline.opts.cards).toBe(false);
    expect(settleBaseline.output).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(settleBaseline.output).toContain('[StaticText] clicks:6');
    expect(state.clicks).toBe(6);

    const dispatchText = await T.jsClickStr(cdp, 'sid', '#p21btn', refMap, refState);
    expect(dispatchText).toMatch(/JS-clicked <BUTTON>/);
    expect(state.clicks).toBe(7);

    const after = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(TARGET_ID, clickTarget, settleBaseline.output, settleBaseline.opts),
      refState,
    );
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    expect(after).toMatch(/\+\s+\[StaticText\] clicks:7/);
    expect(after).not.toMatch(/no changes detected in AX tree/i);
    expect(after).not.toMatch(/chrome-cdp-ex\.cards\.v1/);

    const honest = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: TARGET_ID, ...clickTarget },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(honest.outcome.status).toBe('changed');
    expect(honest.verdict.status).toBe('continue');
    expect(honest.verdict.canContinue).toBe(true);
    const honestText = T.formatActionText(honest);
    expect(honestText).toMatch(/Outcome: changed/);
    expect(honestText).toMatch(/clicks:7/);
    expect(honestText).not.toMatch(/Outcome: no-change/);
    expect(honestText).not.toMatch(/No visible AX tree change/);
    expect(honest.nextSteps.join('\n')).not.toMatch(/overlay/);
  });

  it('#279 leftover-cards + Escape stays expected no-change after default-AX recapture', async () => {
    const { cdp, state } = createPicky21Page({ clicks: 6 });
    const store = { output: null, snapshotOpts: null, cards: null };
    await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { ...T.parsePerceiveArgs(['--cards']), targetPrefix: '62E1DF19' },
      {},
    );
    expect(store.output).toMatch(/0 cards/);

    const escapeTarget = {
      input: 'Escape',
      resolvedBy: 'key',
      label: 'Escape',
      expectedOutcome: 'press-no-change',
    };
    expect(T.shouldCaptureTopLevelActionSettle(store.snapshotOpts, store.output, escapeTarget)).toBe(true);
    const settleBaseline = await recaptureSettleBaseline(cdp, store, escapeTarget);
    expect(settleBaseline.output).toContain('[StaticText] clicks:6');
    expect(state.clicks).toBe(6);

    const after = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      T.actionSettleObserveOpts(TARGET_ID, escapeTarget, settleBaseline.output, settleBaseline.opts),
      {},
    );
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);

    const pressAfterCards = T.applyActionObservationDelta(T.createActionResult({
      action: 'press',
      target: { targetId: TARGET_ID, ...escapeTarget },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(pressAfterCards.outcome.status).toBe('no-change');
    expect(pressAfterCards.effects.diagnosis?.kind).not.toBe('dom-changed');
    const pressText = T.formatActionText(pressAfterCards);
    expect(pressText).toMatch(/Outcome: no-change/);
    expect(pressText).not.toMatch(/Outcome: changed/);
    expect(pressText).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(pressAfterCards.nextSteps.join('\n')).not.toMatch(/perceive .*--cards/);
  });

  it('#279 default-AX perceive then the same click --js stays Outcome: changed', async () => {
    const { cdp, state } = createPicky21Page({ clicks: 7 });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const before = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { targetPrefix: '62E1DF19' },
      {},
    );
    expect(before).toContain('[StaticText] clicks:7');
    expect(store.snapshotOpts.cards).toBe(false);

    const clickTarget = clickJsTarget();
    const settled = T.actionSettleBaseline(store.output, store.snapshotOpts, clickTarget);
    expect(settled.output).toBe(before);
    expect(T.shouldCaptureTopLevelActionSettle(store.snapshotOpts, store.output, clickTarget)).toBe(false);

    await T.jsClickStr(cdp, 'sid', '#p21btn', refMap, {});
    expect(state.clicks).toBe(8);
    const after = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(TARGET_ID, clickTarget, settled.output, settled.opts),
      {},
    );
    expect(after).toMatch(/\+\s+\[StaticText\] clicks:8/);

    const honest = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: TARGET_ID, ...clickTarget },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(honest.outcome.status).toBe('changed');
    expect(T.formatActionText(honest)).toMatch(/clicks:8/);
    expect(T.formatActionText(honest)).not.toMatch(/No visible AX tree change/);
  });

  it('#279 actionFeedback recapture gate is leftover cards as well as leftover frames', () => {
    const src = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/!settleBaseline\.output\s*\n\s*&& shouldCaptureTopLevelActionSettle\(/);
    expect(src).toMatch(
      /function shouldCaptureTopLevelActionSettle[\s\S]{0,1200}snapshotOpts\?\.cards === true \|\| isCardsPerceiveOutput\(output\)/,
    );
  });
});

describe('issue #282 leftover pdf-viewer.v1 press settle', () => {
  const PDF_TARGET_ID = 'CFD023D2E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = 'CFD023D2';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  function pdfViewerCdp() {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({
              result: {
                value: JSON.stringify({
                  title: PDF_PAGE.title,
                  url: PDF_PAGE.url,
                  contentType: PDF_PAGE.contentType,
                  vw: 1042,
                  vh: 632,
                  scrollY: 0,
                  scrollMax: 0,
                  counts: {},
                  focused: 'none',
                  layoutMap: {},
                  styleHints: {},
                  cursorInteractives: [],
                  visibleControls: [],
                }),
              },
            });
          }
          if (expr.includes('innerWidth')) {
            return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({ nodes: [] });
        }
        if (method === 'Input.dispatchKeyEvent') {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
  }

  async function recaptureSettleBaseline(cdp, store, actionTarget, refMap = new Map(), refState = {}) {
    const baselineFromTarget = T.baselineOutputForActionTarget(refState, store.output, actionTarget);
    let settleBaseline = T.actionSettleBaseline(
      baselineFromTarget,
      store.snapshotOpts || null,
      actionTarget,
    );
    if (
      !settleBaseline.output
      && T.shouldCaptureTopLevelActionSettle(
        store.snapshotOpts,
        baselineFromTarget,
        actionTarget,
      )
    ) {
      const topLevelOpts = T.actionObservationPerceiveOpts(PDF_TARGET_ID, {
        ...(settleBaseline.opts || {}),
        frameRef: null,
      });
      const before = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        topLevelOpts,
        refState,
      );
      settleBaseline = {
        output: before,
        opts: T.perceiveSnapshotOpts(topLevelOpts),
      };
    }
    return settleBaseline;
  }

  async function observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap = new Map(), refState = {}) {
    if (!settleBaseline.output) {
      const after = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        T.actionObservationPerceiveOpts(PDF_TARGET_ID),
        refState,
      );
      if (String(after || '').includes('chrome-cdp-ex.pdf-viewer.v1')) {
        return typeof T.pdfViewerSettleDiffText === 'function'
          ? T.pdfViewerSettleDiffText()
          : T.noBaselineActionDiffText();
      }
      return T.noBaselineActionDiffText();
    }
    return T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(PDF_TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts),
      refState,
    );
  }

  async function leftoverPdfPressReceipt({ leftover = true, key = 'Escape' } = {}) {
    const cdp = pdfViewerCdp();
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    let leftoverDump = null;
    if (leftover) {
      leftoverDump = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        { targetPrefix: PDF_PREFIX },
        refState,
      );
      expect(leftoverDump).toContain('chrome-cdp-ex.pdf-viewer.v1');
      expect(leftoverDump).toContain('Accessibility tree is empty');
    }
    const actionTarget = {
      input: key,
      resolvedBy: 'key',
      label: key,
      expectedOutcome: 'press-no-change',
    };
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    const dispatchText = await T.pressStr(cdp, 'sid', key);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'press',
      target: { targetId: PDF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    return { cdp, store, leftoverDump, settleBaseline, dispatchText, after, result, text, receipt };
  }

  function expectHonestNoChangePress(got, { key } = {}) {
    expect(got.dispatchText).toBe(`Pressed ${key === 'Escape' ? 'Escape' : key}`);
    expect(got.result.outcome.status).toBe('no-change');
    expect(got.result.verdict.status).toBe('continue');
    expect(got.result.effects.diagnosis?.kind).not.toBe('dom-changed');
    expect(got.text).toMatch(/Outcome: no-change/);
    expect(got.text).not.toMatch(/Outcome: changed/);
    expect(got.text).not.toMatch(/Observed page change after action/);
    expect(got.receipt).not.toMatch(/Observed page change after action/);
    expect(got.after).toMatch(/no changes detected/i);
    expect(got.after).not.toMatch(/Accessibility tree is empty for this viewer/);
    expect(got.after).not.toMatch(/PDF viewer: Chrome is rendering a PDF plugin/);
  }

  it('#282 leftover pdf-viewer.v1 is not a valid AX settle shape', async () => {
    const cdp = pdfViewerCdp();
    const store = { output: null, snapshotOpts: null };
    const dump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { targetPrefix: PDF_PREFIX },
      {},
    );
    expect(dump).toContain('chrome-cdp-ex.pdf-viewer.v1');
    if (typeof T.isPdfViewerPerceiveOutput === 'function') {
      expect(T.isPdfViewerPerceiveOutput(dump)).toBe(true);
    }
    expect(T.actionDomDiffShowsChange(dump)).toBe(false);

    const escapeTarget = {
      input: 'Escape',
      resolvedBy: 'key',
      label: 'Escape',
      expectedOutcome: 'press-no-change',
    };
    const settled = T.actionSettleBaseline(dump, store.snapshotOpts, escapeTarget);
    expect(settled.output).toBeNull();
    expect(T.shouldCaptureTopLevelActionSettle(store.snapshotOpts, dump, escapeTarget)).toBe(false);

    const cardsDump = 'chrome-cdp-ex.cards.v1  0 cards\nnext: cdp perceive 62E1DF19 --cards';
    expect(T.shouldCaptureTopLevelActionSettle(
      T.perceiveSnapshotOpts({ cards: true }),
      cardsDump,
      escapeTarget,
    )).toBe(true);
    expect(T.actionSettleBaseline(cardsDump, T.perceiveSnapshotOpts({ cards: true }), escapeTarget).output).toBeNull();
  });

  it('#282 leftover pdf-viewer.v1 then press Escape is expected no-change / continue', async () => {
    const got = await leftoverPdfPressReceipt({ leftover: true, key: 'Escape' });
    expect(got.settleBaseline.output).toBeNull();
    expectHonestNoChangePress(got, { key: 'Escape', leftover: true });
    expect(got.receipt).toMatch(/Pressed Escape/);
  });

  it('#282 leftover pdf-viewer.v1 then press ArrowRight with unchanged URL/type/empty AX is no-change', async () => {
    const got = await leftoverPdfPressReceipt({ leftover: true, key: 'ArrowRight' });
    expect(got.settleBaseline.output).toBeNull();
    expectHonestNoChangePress(got, { key: 'ArrowRight', leftover: true });
    expect(got.receipt).not.toMatch(/PDF viewer: Chrome is rendering a PDF plugin/);
  });

  it('#282 press ArrowRight with no leftover pdf-viewer dump stays honest no-change', async () => {
    const got = await leftoverPdfPressReceipt({ leftover: false, key: 'ArrowRight' });
    expect(
      got.store.output == null
      || String(got.store.output).includes('chrome-cdp-ex.pdf-viewer.v1'),
    ).toBe(true);
    expectHonestNoChangePress(got, { key: 'ArrowRight', leftover: false });
    expect(got.text).not.toMatch(/Observed page change after action/);
  });

  it('#282 leftover pdf-viewer since-action perceive does not treat stub vs stub as a page change', async () => {
    const cdp = pdfViewerCdp();
    const store = { output: null, snapshotOpts: null };
    const before = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { targetPrefix: PDF_PREFIX },
      {},
    );
    const after = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      {
        targetPrefix: PDF_PREFIX,
        sinceAction: true,
        diffBaseline: before,
      },
      {},
    );
    expect(after).toMatch(/no changes detected/i);
    expect(after).toMatch(/pdf-viewer\.v1/);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    expect(after).not.toMatch(/Accessibility tree is empty for this viewer/);
    if (typeof T.pdfViewerSettleDiffText === 'function') {
      expect(after).toBe(T.pdfViewerSettleDiffText());
    }
  });
});

describe('issue #285 leftover pdf-viewer.v1 click --js / scroll Next', () => {
  const PDF_TARGET_ID = 'CFD023D2E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = 'CFD023D2';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  function pdfViewerCdp() {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('scrollBy')) {
            return Promise.resolve({ result: { value: '{"x":0,"y":0}' } });
          }
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({
              result: {
                value: JSON.stringify({
                  title: PDF_PAGE.title,
                  url: PDF_PAGE.url,
                  contentType: PDF_PAGE.contentType,
                  vw: 1042,
                  vh: 632,
                  scrollY: 0,
                  scrollMax: 0,
                  counts: {},
                  focused: 'none',
                  layoutMap: {},
                  styleHints: {},
                  cursorInteractives: [],
                  visibleControls: [],
                }),
              },
            });
          }
          if (expr.includes('innerWidth')) {
            return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({ nodes: [] });
        }
        if (method === 'Input.dispatchKeyEvent' || method === 'Input.dispatchMouseEvent') {
          return Promise.resolve({});
        }
        if (method === 'DOM.getDocument') {
          return Promise.resolve({ root: { nodeId: 1 } });
        }
        if (method === 'DOM.querySelector') {
          return Promise.resolve({ nodeId: 2 });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'pdf-body' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          return Promise.resolve({ result: { value: { tag: 'BODY', text: '' } } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
  }

  async function recaptureSettleBaseline(cdp, store, actionTarget, refMap = new Map(), refState = {}) {
    const baselineFromTarget = T.baselineOutputForActionTarget(refState, store.output, actionTarget);
    let settleBaseline = T.actionSettleBaseline(
      baselineFromTarget,
      store.snapshotOpts || null,
      actionTarget,
    );
    if (
      !settleBaseline.output
      && T.shouldCaptureTopLevelActionSettle(
        store.snapshotOpts,
        baselineFromTarget,
        actionTarget,
      )
    ) {
      const topLevelOpts = T.actionObservationPerceiveOpts(PDF_TARGET_ID, {
        ...(settleBaseline.opts || {}),
        frameRef: null,
      });
      const before = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        topLevelOpts,
        refState,
      );
      settleBaseline = {
        output: before,
        opts: T.perceiveSnapshotOpts(topLevelOpts),
      };
    }
    return settleBaseline;
  }

  async function observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap = new Map(), refState = {}) {
    if (!settleBaseline.output) {
      const after = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        T.actionObservationPerceiveOpts(PDF_TARGET_ID),
        refState,
      );
      if (String(after || '').includes('chrome-cdp-ex.pdf-viewer.v1')) {
        return typeof T.pdfViewerSettleDiffText === 'function'
          ? T.pdfViewerSettleDiffText()
          : T.noBaselineActionDiffText();
      }
      return T.noBaselineActionDiffText();
    }
    return T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(PDF_TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts),
      refState,
    );
  }

  function expectPdfViewerContinue(got, { nextMustNotInclude } = {}) {
    expect(got.settleBaseline.output).toBeNull();
    expect(got.result.outcome.status).toBe('no-change');
    expect(got.result.verdict.status).toBe('continue');
    expect(got.text).toMatch(/Outcome: no-change/);
    expect(got.text).not.toMatch(/Outcome: changed/);
    expect(got.text).toMatch(/Verdict: continue/);
    expect(got.text).not.toMatch(/Verdict: investigate/);
    expect(got.text).toMatch(/Next: cdp eval CFD023D2 "document.contentType"/);
    expect(got.text).not.toMatch(/cdp overlay /);
    expect(got.text).not.toMatch(/cdp perceive CFD023D2 -C/);
    expect(got.result.recommendation?.commands?.[0]).toBe('cdp eval CFD023D2 "document.contentType"');
    for (const banned of nextMustNotInclude || []) {
      expect(got.text).not.toMatch(banned);
    }
  }

  async function leftoverPdfMutatorReceipt({ leftover = true, kind } = {}) {
    const cdp = pdfViewerCdp();
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    if (leftover) {
      const leftoverDump = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        { targetPrefix: PDF_PREFIX },
        refState,
      );
      expect(leftoverDump).toContain('chrome-cdp-ex.pdf-viewer.v1');
    }
    const actionTarget = kind === 'scroll'
      ? {
        input: 'down',
        resolvedBy: 'scroll',
        label: 'down',
        page: { ...PDF_PAGE },
      }
      : kind === 'press'
        ? {
          input: 'Escape',
          resolvedBy: 'key',
          label: 'Escape',
          expectedOutcome: 'press-no-change',
          page: { ...PDF_PAGE },
        }
        : {
          input: 'body',
          resolvedBy: 'selector-or-ref',
          label: 'body',
          commandArgs: ['--js', 'body'],
          page: { ...PDF_PAGE },
        };
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    let dispatchText;
    let action;
    if (kind === 'scroll') {
      action = 'scroll';
      dispatchText = await T.scrollStr(cdp, 'sid', 'down', '100');
    } else if (kind === 'press') {
      action = 'press';
      dispatchText = await T.pressStr(cdp, 'sid', 'Escape');
    } else {
      action = 'click';
      dispatchText = await T.jsClickStr(cdp, 'sid', 'body', refMap, refState);
    }
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    const result = T.applyActionObservationDelta(T.createActionResult({
      action,
      target: { targetId: PDF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: action },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    return { cdp, store, settleBaseline, dispatchText, after, result, text, receipt };
  }

  it('#285 leftover pdf-viewer.v1 then click --js body is no-change / continue, Next eval not overlay', async () => {
    const got = await leftoverPdfMutatorReceipt({ leftover: true, kind: 'click-js' });
    expect(got.dispatchText).toMatch(/JS-clicked <BODY>/);
    expect(got.after).toMatch(/no changes detected/i);
    expectPdfViewerContinue(got, { nextMustNotInclude: [/cdp overlay CFD023D2 body/] });
  });

  it('#285 leftover pdf-viewer.v1 then scroll down at (0,0) is no-change / continue, Next eval not perceive', async () => {
    const got = await leftoverPdfMutatorReceipt({ leftover: true, kind: 'scroll' });
    expect(got.dispatchText).toBe('Scrolled by (0, 100). Position: (0, 0)');
    expect(got.after).toMatch(/no changes detected/i);
    expectPdfViewerContinue(got, { nextMustNotInclude: [/cdp perceive CFD023D2 -C -d 8/] });
  });

  it('#285 leftover pdf-viewer.v1 then press Escape still no-change / continue (#282 hold)', async () => {
    const got = await leftoverPdfMutatorReceipt({ leftover: true, kind: 'press' });
    expect(got.dispatchText).toBe('Pressed Escape');
    expect(got.result.outcome.status).toBe('no-change');
    expect(got.result.verdict.status).toBe('continue');
    expect(got.text).not.toMatch(/Outcome: changed/);
    expect(got.after).toMatch(/no changes detected/i);
    expect(got.after).toMatch(/pdf-viewer\.v1/);
  });
});

describe('issue #293 leftover feed --cards scroll settle', () => {
  const X_TARGET_ID = '2E94F948ABCDEF0123456789ABCDEF01';
  const X_PREFIX = '2E94F948';
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  const DEFAULT_POSTS = [
    { text: 'first tweet body', backend: 201, handle: '@SY239434', statusId: '1001' },
    { text: 'second tweet body', backend: 202, handle: '@SY239434', statusId: '1002' },
  ];
  const ADDED_THIRD_POSTS = [
    ...DEFAULT_POSTS,
    { text: 'third tweet body', backend: 203, handle: '@SY239434', statusId: '1003' },
  ];

  function xMeta({ scrollY = 0, articleCount = 2 } = {}) {
    return JSON.stringify({
      title: 'SY239434 (@SY239434) / X',
      url: 'https://x.com/SY239434',
      contentType: 'text/html',
      vw: 1042,
      vh: 900,
      scrollY,
      scrollMax: 4000,
      counts: { article: articleCount, button: 8 },
      focused: 'none',
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
      visibleControls: [{
        tag: 'button',
        role: 'button',
        label: 'p25',
        clickable: true,
        rect: { x: 8, y: 80, w: 80, h: 24 },
        selector: 'button#p25btn',
        hints: { id: 'p25btn', classes: [] },
      }],
    });
  }

  function xAx({ age = '2m', clicks = 0, ageInArticleName = false, posts = DEFAULT_POSTS } = {}) {
    const articleNodes = [];
    const feedChildIds = [];
    for (const [index, post] of posts.entries()) {
      const articleId = String(20 + index);
      const handleId = `${articleId}1`;
      const timeId = `${articleId}2`;
      const permalinkId = `${articleId}3`;
      feedChildIds.push(articleId);
      const name = ageInArticleName ? `${post.text} · ${age}` : post.text;
      const timeName = ageInArticleName ? 'likes' : age;
      articleNodes.push(
        {
          nodeId: articleId,
          parentId: '10',
          role: { value: 'article' },
          name: { value: name },
          backendDOMNodeId: post.backend,
          childIds: [handleId, permalinkId, timeId],
        },
        { nodeId: handleId, parentId: articleId, role: { value: 'link' }, name: { value: post.handle } },
        {
          nodeId: permalinkId,
          parentId: articleId,
          role: { value: 'link' },
          name: { value: 'Show this post' },
          properties: [{ name: 'url', value: { value: `https://x.com/SY239434/status/${post.statusId}` } }],
        },
        { nodeId: timeId, parentId: articleId, role: { value: 'StaticText' }, name: { value: timeName } },
      );
    }
    return [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'SY239434' }, childIds: ['10', '4', '5'] },
      { nodeId: '10', parentId: '1', role: { value: 'feed' }, name: { value: 'Timeline' }, childIds: feedChildIds },
      ...articleNodes,
      { nodeId: '4', parentId: '1', role: { value: 'button' }, name: { value: 'p25' }, backendDOMNodeId: 25 },
      { nodeId: '5', parentId: '1', role: { value: 'StaticText' }, name: { value: `clicks:${clicks}` } },
    ];
  }

  function createXPage({
    age = '2m',
    scrollY = 0,
    clicks = 0,
    ageInArticleName = false,
    posts = DEFAULT_POSTS,
  } = {}) {
    const state = {
      age,
      scrollY,
      clicks,
      ageInArticleName,
      posts: posts.map(post => ({ ...post })),
    };
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'main-frame', url: 'https://x.com/SY239434' } } });
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('scrollBy')) {
            state.scrollY += 80;
            return Promise.resolve({ result: { value: JSON.stringify({ x: 0, y: state.scrollY }) } });
          }
          if (expr.includes("resolve('stable')") || expr.includes('MutationObserver')) {
            return Promise.resolve({ result: { value: 'stable' } });
          }
          if (expr.includes('#p25btn') && expr.includes('click')) {
            state.clicks += 1;
            return Promise.resolve({ result: { value: JSON.stringify({ tag: 'BUTTON', text: 'p25' }) } });
          }
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({
              result: { value: xMeta({ scrollY: state.scrollY, articleCount: state.posts.length }) },
            });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({
            nodes: xAx({
              age: state.age,
              clicks: state.clicks,
              ageInArticleName: state.ageInArticleName,
              posts: state.posts,
            }),
          });
        }
        if (method === 'DOM.getDocument') {
          return Promise.resolve({ root: { nodeId: 1 } });
        }
        if (method === 'DOM.querySelector') {
          return Promise.resolve({ nodeId: 2 });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'x-node' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('this.click()')) {
            state.clicks += 1;
            return Promise.resolve({ result: { value: { tag: 'BUTTON', text: 'p25' } } });
          }
          return Promise.resolve({ result: { value: { x: 8, y: 80, w: 400, h: 120, position: '', tag: 'BUTTON', text: 'p25' } } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
    return { cdp, state };
  }

  function scrollTarget() {
    return {
      input: 'down 80',
      resolvedBy: 'scroll',
      label: 'down',
      commandArgs: ['down', '80'],
      expectedOutcome: 'cards-window-no-change',
    };
  }

  function clickJsTarget() {
    return {
      input: '#p25btn',
      resolvedBy: 'selector-or-ref',
      label: '#p25btn',
      commandArgs: ['--js', '#p25btn'],
    };
  }

  async function leftoverCards(cdp, store, refMap, refState, args = ['--cards']) {
    const dump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { ...T.parsePerceiveArgs(args), targetPrefix: X_PREFIX },
      refState,
    );
    expect(dump).toContain('chrome-cdp-ex.cards.v1');
    expect(dump).toMatch(/2 cards/);
    expect(store.snapshotOpts.cards).toBe(true);
    expect(T.leftoverCardsCount(dump)).toBe(2);
    expect(T.isLeftoverFeedCardsSettle(dump, store.snapshotOpts, scrollTarget())).toBe(true);
    return dump;
  }

  async function recaptureSettleBaseline(cdp, store, actionTarget, refMap = new Map(), refState = {}) {
    const baselineFromTarget = T.baselineOutputForActionTarget(refState, store.output, actionTarget);
    let settleBaseline = T.actionSettleBaseline(
      baselineFromTarget,
      store.snapshotOpts || null,
      actionTarget,
    );
    if (
      !settleBaseline.output
      && T.shouldCaptureTopLevelActionSettle(
        store.snapshotOpts,
        baselineFromTarget,
        actionTarget,
      )
    ) {
      const topLevelOpts = T.actionObservationPerceiveOpts(X_TARGET_ID, {
        ...(settleBaseline.opts || {}),
        frameRef: null,
      });
      const before = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        topLevelOpts,
        refState,
      );
      settleBaseline = {
        output: before,
        opts: T.perceiveSnapshotOpts(topLevelOpts),
      };
    }
    return settleBaseline;
  }

  async function observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap = new Map(), refState = {}) {
    if (!settleBaseline.output) {
      return T.noBaselineActionDiffText();
    }
    return T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(X_TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts),
      refState,
    );
  }

  it('#293 leftover feed --cards is a scroll settle shape, not a full AX recapture', () => {
    const cardsDump = [
      'chrome-cdp-ex.cards.v1  2 cards  virtualized',
      '@1  @SY239434  first tweet body',
      '@2  @SY239434  second tweet body',
      'next: timeline virtualized; scroll and re-run --cards',
    ].join('\n');
    const snapshotOpts = T.perceiveSnapshotOpts({ cards: true });
    const scroll = scrollTarget();
    expect(T.isCardsPerceiveOutput(cardsDump)).toBe(true);
    expect(T.leftoverCardsCount(cardsDump)).toBe(2);
    expect(T.isScrollActionTarget(scroll)).toBe(true);
    expect(T.isLeftoverFeedCardsSettle(cardsDump, snapshotOpts, scroll)).toBe(true);
    expect(T.shouldCaptureTopLevelActionSettle(snapshotOpts, cardsDump, scroll)).toBe(false);

    const settled = T.actionSettleBaseline(cardsDump, snapshotOpts, scroll);
    expect(settled.output).toBe(cardsDump);
    expect(settled.opts.cards).toBe(true);
    expect(T.actionSettleObserveOpts(X_TARGET_ID, scroll, settled.output, settled.opts).cards).toBe(true);

    const zeroDump = 'chrome-cdp-ex.cards.v1  0 cards\nnext: cdp perceive 2E94F948 --cards';
    expect(T.isLeftoverFeedCardsSettle(zeroDump, snapshotOpts, scroll)).toBe(false);
    expect(T.shouldCaptureTopLevelActionSettle(snapshotOpts, zeroDump, scroll)).toBe(true);
    expect(T.actionSettleBaseline(zeroDump, snapshotOpts, scroll).output).toBeNull();

    const click = clickJsTarget();
    expect(T.isLeftoverFeedCardsSettle(cardsDump, snapshotOpts, click)).toBe(false);
    expect(T.shouldCaptureTopLevelActionSettle(snapshotOpts, cardsDump, click)).toBe(true);
    expect(T.actionSettleBaseline(cardsDump, snapshotOpts, click).output).toBeNull();
    expect(T.actionObservationPerceiveOpts(X_TARGET_ID, { cards: true }).cards).toBe(false);
  });

  it('#293 leftover feed --cards then scroll is no-change / continue, Next --cards, not AX timestamp chrome', async () => {
    const { cdp, state } = createXPage({ age: '2m', scrollY: 0 });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverCards(cdp, store, refMap, refState, ['--cards']);
    const axBeforeLeftover = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;

    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toContain('chrome-cdp-ex.cards.v1');
    expect(settleBaseline.opts.cards).toBe(true);
    expect(settleBaseline.output).not.toMatch(/\[StaticText\]/);
    const axAfterRecaptureGate = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    expect(axAfterRecaptureGate).toBe(axBeforeLeftover);

    state.age = '3m';
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    expect(state.scrollY).toBe(80);

    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toContain('chrome-cdp-ex.cards.v1');
    expect(after).toMatch(/unchanged; still first cards/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    expect(after).not.toMatch(/\[StaticText\] 3m/);
    expect(after).not.toMatch(/Outcome: changed/);

    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: X_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Outcome: no-change/);
    expect(text).not.toMatch(/Outcome: changed/);
    expect(text).toMatch(/Next: cdp perceive 2E94F948 --cards/);
    expect(text).not.toMatch(/cdp perceive 2E94F948 -C -d 8/);
    expect(text).not.toMatch(/cdp report 2E94F948 --format json/);
    expect(receipt).toContain(leftoverDump.split('\n')[1]);
    expect(receipt).not.toMatch(/\[RootWebArea\]/);
    expect(receipt).not.toMatch(/Text nodes updated/);
    expect(after).not.toMatch(/^Page: /m);
  });

  it('#293 leftover --role feed with cards then scroll keeps the cards window', async () => {
    const { cdp, state } = createXPage({ age: '2m', scrollY: 0 });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const refState = {};
    await leftoverCards(cdp, store, refMap, refState, ['--role', 'feed']);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.opts.cards).toBe(true);
    state.age = '3m';
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    expect(after).toMatch(/unchanged; still first cards/i);
  });

  it('#293 leftover feed --cards then scroll that adds a third article is Outcome: changed', async () => {
    const { cdp, state } = createXPage({ age: '2m', scrollY: 0 });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const refState = {};
    await leftoverCards(cdp, store, refMap, refState, ['--cards']);
    const actionTarget = scrollTarget();
    expect(actionTarget.expectedOutcome).toBe('cards-window-no-change');
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.opts.cards).toBe(true);

    // Leftover window is 2 cards. Scroll adds a third article identity.
    // expectedOutcome is set pre-scroll and must not hide that mutation.
    state.posts = ADDED_THIRD_POSTS.map(post => ({ ...post }));
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toContain('chrome-cdp-ex.cards.v1');
    expect(after).toMatch(/chrome-cdp-ex\.cards\.v1\s+3 cards/);
    expect(after).toMatch(/third tweet body/);
    expect(after).not.toMatch(/unchanged; still first cards/i);
    expect(after).not.toMatch(/\[RootWebArea\]/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    expect(T.isExpectedNoChange(actionTarget, after, 'scroll')).toBe(true);

    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: X_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Outcome: changed/);
    expect(text).not.toMatch(/Outcome: no-change/);
    expect(receipt).toContain('third tweet body');
    expect(receipt).toMatch(/chrome-cdp-ex\.cards\.v1\s+3 cards/);
    expect(receipt).not.toMatch(/unchanged; still first cards/);
    expect(receipt).not.toMatch(/\[RootWebArea\]/);
  });

  it('#293 leftover feed --cards then scroll ignores relative time in article AX name (2m→3m)', async () => {
    // Contract: extractText/cardIdentity use article AX `name`, not child
    // StaticText. Clock chrome lives in the name (`first tweet body · 2m`).
    // Child StaticText is `likes`, not the time. If this helper were
    // Outcome: changed, leftover cards.v1 would still treat timestamp-in-name
    // as a feed mutation on live X unless 9224 `perceive --cards` lines omit
    // the relative time. no-change here is required: identity strips `· 2m`.
    const { cdp, state } = createXPage({ age: '2m', scrollY: 0, ageInArticleName: true });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverCards(cdp, store, refMap, refState, ['--cards']);
    expect(leftoverDump).toMatch(/first tweet body · 2m/);
    expect(leftoverDump).not.toMatch(/\blikes\b/);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.opts.cards).toBe(true);

    state.age = '3m';
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toContain('chrome-cdp-ex.cards.v1');
    expect(after).toMatch(/first tweet body · 3m/);
    expect(after).toMatch(/unchanged; still first cards/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);

    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: X_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Outcome: no-change/);
    expect(text).not.toMatch(/Outcome: changed/);
    expect(text).toMatch(/Next: cdp perceive 2E94F948 --cards/);
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
  });

  it('#293 leftover feed --cards then click --js still recaptures default AX (#279 hold)', async () => {
    const { cdp, state } = createXPage({ age: '2m', clicks: 6 });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const refState = {};
    await leftoverCards(cdp, store, refMap, refState, ['--cards']);
    const actionTarget = clickJsTarget();
    expect(T.shouldCaptureTopLevelActionSettle(store.snapshotOpts, store.output, actionTarget)).toBe(true);
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.opts.cards).toBe(false);
    expect(settleBaseline.output).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(settleBaseline.output).toContain('[StaticText] clicks:6');
    expect(T.actionSettleObserveOpts(X_TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts).cards)
      .toBe(false);

    const dispatchText = await T.jsClickStr(cdp, 'sid', '#p25btn', refMap, refState);
    expect(dispatchText).toMatch(/JS-clicked <BUTTON>/);
    expect(state.clicks).toBe(7);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    expect(after).toMatch(/\+\s+\[StaticText\] clicks:7/);
    expect(after).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
  });
});

describe('issue #295 leftover golden-path AX scroll rect chrome', () => {
  const HF_TARGET_ID = '561F7DA8ABCDEF0123456789ABCDEF01';
  const HF_PREFIX = '561F7DA8';
  const HF_URL = 'https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main';
  const COMFY_TARGET_ID = '0D34570AABCDEF0123456789ABCDEF01';
  const COMFY_PREFIX = '0D34570A';
  const COMFY_URL = 'https://docs.comfy.org/tutorials/audio/minimax/minimax-music-3';
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  const DEFAULT_FILES = [
    { name: 'LICENSE', backend: 301, y: 180 },
    { name: 'README.md', backend: 302, y: 208 },
    { name: 'config.json', backend: 303, y: 236 },
  ];
  const ADDED_FILE = { name: 'tokenizer.json', backend: 304, y: 264 };

  const CAP_SWAP_CHROME = [
    'Hugging Face', 'Models', 'Datasets', 'Spaces', 'Posts', 'search', 'docs', 'pricing',
  ];
  const CAP_SWAP_CONTENT = [
    'MiniMaxAI', 'MiniMax-Music3', 'Copy', 'Like', 'LICENSE', 'README.md', 'config.json', 'Files',
  ];
  const TIMESTAMP_CAP_SWAP_CHROME = [
    'ryanlee-dev', 'Update README.md', 'fbdf52f', 'assets',
  ];
  const TIMESTAMP_CAP_SWAP_CONTENT = [
    'condition_encoder',
    'Add diffusers weights (modular pipeline) (#2)',
    'config.json',
  ];
  const SHARED_COMMIT_TITLE = 'Add diffusers weights (modular pipeline) (#2)';

  function hfVisibleControl(label, y, selector = null) {
    return {
      tag: 'a',
      role: 'link',
      label,
      clickable: true,
      rect: { x: 24, y, w: 160, h: 22 },
      selector: selector || `a[href="#${label.replace(/\s+/g, '-')}"]`,
      hints: { id: '', classes: [] },
    };
  }

  function hfUnlabeledControl(tag, y, selector) {
    // Live collector: ariaLabel || title || text || role || tagName.
    const role = tag === 'a' ? 'link' : '';
    return {
      tag,
      role,
      label: role || tag,
      clickable: true,
      rect: { x: 8, y, w: 24, h: 24 },
      selector,
      hints: { id: '', classes: [] },
    };
  }

  function noisyCapSwapChrome() {
    return [
      hfUnlabeledControl('img', 12, 'img.logo'),
      hfUnlabeledControl('div', 40, 'div.nav-icon'),
      hfUnlabeledControl('a', 68, 'a[href="/"]'),
      ...CAP_SWAP_CHROME.map((label, i) => hfVisibleControl(label, 100 + i * 28)),
    ];
  }

  function noisyCapSwapContent() {
    return [
      hfUnlabeledControl('img', 12, 'img.hero'),
      hfUnlabeledControl('div', 40, 'div.body-icon'),
      hfUnlabeledControl('a', 68, 'a[href="/model"]'),
      ...CAP_SWAP_CONTENT.map((label, i) => hfVisibleControl(label, 100 + i * 28)),
    ];
  }

  function hfTitleChromeControls() {
    // Live leftover-ax-scroll Added lines after overlay f16bf750. Collector
    // includes [title] even when not clickable; formatVisibleControlLine
    // reprints title= selector + CSS classes.
    return [
      {
        tag: 'span',
        label: 'This commit is signed and the signature is verified',
        title: 'This commit is signed and the signature is verified',
        clickable: false,
        rect: { x: 400, y: 120, w: 18, h: 18 },
        selector: 'span[title="This commit is signed and the signature is verified"]',
        hints: { classes: ['mx-2', 'text-green-500', 'dark:text-green-600'] },
      },
      {
        tag: 'time',
        label: 'Fri, 14 Aug 2026 10:51:40 GMT',
        title: 'Fri, 14 Aug 2026 10:51:40 GMT',
        clickable: false,
        rect: { x: 800, y: 120, w: 40, h: 16 },
        selector: 'time[title="Fri, 14 Aug 2026 10:51:40 GMT"]',
        hints: { classes: ['ml-auto', 'hidden', 'flex-none'] },
      },
    ];
  }

  function hfTimestampChromeControls() {
    // Live leftover-ax-scroll named samples after overlay 3577e604. HF file-row
    // `<a>…<time title="Thu, 13 Aug 2026 15:18:27 GMT">2 days ago</time></a>`:
    // collector label for <a> is inner text; <time> label is title (title wins).
    return [
      {
        tag: 'a',
        role: 'link',
        label: '2 days ago',
        clickable: true,
        rect: { x: 720, y: 184, w: 72, h: 16 },
        selector: 'a.truncate',
        hints: { classes: ['truncate'] },
      },
      {
        tag: 'time',
        label: 'Thu, 13 Aug 2026 15:18:27 GMT',
        title: 'Thu, 13 Aug 2026 15:18:27 GMT',
        clickable: true,
        rect: { x: 800, y: 184, w: 72, h: 16 },
        selector: 'time[title="Thu, 13 Aug 2026 15:18:27 GMT"]',
        hints: { classes: ['ml-auto', 'hidden', 'flex-none'] },
      },
    ];
  }

  function sharedCommitCapSwapChrome() {
    // Live leftover-ax-scroll named samples after overlay f9fa4971. Each HF
    // file row reprints the same commit title with a distinct href, so the
    // name is both left and entered membership.
    return [
      hfVisibleControl('condition_encoder', 100),
      hfVisibleControl(SHARED_COMMIT_TITLE, 128, 'a[href="/MiniMaxAI/MiniMax-Music3/commit/left"]'),
      hfVisibleControl('figures', 156),
      hfVisibleControl('tokenizer.json', 184),
    ];
  }

  function sharedCommitCapSwapContent() {
    return [
      hfVisibleControl('language_model', 100),
      hfVisibleControl(SHARED_COMMIT_TITLE, 128, 'a[href="/MiniMaxAI/MiniMax-Music3/commit/entered"]'),
      hfVisibleControl('qwen_7B', 156),
      hfVisibleControl('speech_tokenizer', 184),
    ];
  }

  function hfMeta(scrollY, files, {
    foldTag = false,
    capSwap = false,
    noisyCapSwap = false,
    titleChrome = false,
    timestampCapSwap = false,
    sharedCommitCapSwap = false,
  } = {}) {
    const fileControls = files.map(file => hfVisibleControl(file.name, file.y - scrollY));
    let visibleControls = sharedCommitCapSwap
      ? (scrollY > 0 ? sharedCommitCapSwapContent() : sharedCommitCapSwapChrome())
      : timestampCapSwap
      ? (scrollY > 0
        ? [
          ...TIMESTAMP_CAP_SWAP_CONTENT.map((label, i) => hfVisibleControl(label, 100 + i * 28)),
          ...hfTimestampChromeControls(),
        ]
        : TIMESTAMP_CAP_SWAP_CHROME.map((label, i) => hfVisibleControl(label, 100 + i * 28)))
      : noisyCapSwap
      ? (scrollY > 0 ? noisyCapSwapContent() : noisyCapSwapChrome())
      : capSwap
      ? (scrollY > 0 ? CAP_SWAP_CONTENT : CAP_SWAP_CHROME).map((label, i) => (
        hfVisibleControl(label, 12 + i * 28)
      ))
      : fileControls;
    if (titleChrome && scrollY > 0) {
      visibleControls = [...hfTitleChromeControls(), ...visibleControls];
    }
    return JSON.stringify({
      title: 'MiniMaxAI/MiniMax-Music3 at main',
      url: HF_URL,
      contentType: 'text/html',
      vw: 1042,
      vh: 900,
      scrollY,
      scrollMax: 2400,
      counts: { a: files.length },
      focused: 'none',
      layoutMap: foldTag || capSwap
        ? { navigation: [{ w: 603, h: 28, ...(scrollY > 0 ? { vis: 'above' } : {}) }] }
        : {},
      styleHints: {},
      cursorInteractives: [],
      visibleControls,
    });
  }

  function hfAx(files, { foldTag = false, capSwap = false, noisyCapSwap = false, timestampCapSwap = false, sharedCommitCapSwap = false } = {}) {
    const links = files.map((file, i) => ({
      nodeId: String(20 + i),
      parentId: '10',
      role: { value: 'link' },
      name: { value: file.name },
      backendDOMNodeId: file.backend,
    }));
    const withNav = foldTag || capSwap || noisyCapSwap || timestampCapSwap || sharedCommitCapSwap;
    return [
      {
        nodeId: '1',
        role: { value: 'RootWebArea' },
        name: { value: 'MiniMax-Music3' },
        childIds: withNav ? ['5', '10', '99'] : ['10', '99'],
      },
      ...(withNav ? [{
        nodeId: '5',
        parentId: '1',
        role: { value: 'navigation' },
        name: { value: 'Main' },
      }] : []),
      { nodeId: '10', parentId: '1', role: { value: 'main' }, name: { value: '' }, childIds: links.map(n => n.nodeId) },
      ...links,
      {
        nodeId: '99',
        parentId: '1',
        role: { value: 'button' },
        name: { value: 'p26' },
        backendDOMNodeId: 399,
      },
    ];
  }

  function createHfPage({
    scrollY = 0,
    clicks = 0,
    files = DEFAULT_FILES,
    foldTag = false,
    capSwap = false,
    noisyCapSwap = false,
    titleChrome = false,
    timestampCapSwap = false,
    sharedCommitCapSwap = false,
  } = {}) {
    const state = {
      scrollY,
      clicks,
      files: files.map(file => ({ ...file })),
      foldTag,
      capSwap: capSwap || noisyCapSwap || timestampCapSwap || sharedCommitCapSwap,
      noisyCapSwap,
      titleChrome,
      timestampCapSwap,
      sharedCommitCapSwap,
    };
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'main-frame', url: HF_URL } } });
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('scrollBy')) {
            state.scrollY += 80;
            return Promise.resolve({ result: { value: JSON.stringify({ x: 0, y: state.scrollY }) } });
          }
          if (expr.includes("resolve('stable')") || expr.includes('MutationObserver')) {
            return Promise.resolve({ result: { value: 'stable' } });
          }
          if (expr.includes('#p26btn') && expr.includes('click')) {
            state.clicks += 1;
            return Promise.resolve({ result: { value: JSON.stringify({ tag: 'BUTTON', text: 'p26' }) } });
          }
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({
              result: {
                value: hfMeta(state.scrollY, state.files, {
                  foldTag: state.foldTag,
                  capSwap: state.capSwap,
                  noisyCapSwap: state.noisyCapSwap,
                  titleChrome: state.titleChrome,
                  timestampCapSwap: state.timestampCapSwap,
                  sharedCommitCapSwap: state.sharedCommitCapSwap,
                }),
              },
            });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          const nodes = hfAx(state.files, {
            foldTag: state.foldTag,
            capSwap: state.capSwap,
            noisyCapSwap: state.noisyCapSwap,
            timestampCapSwap: state.timestampCapSwap,
            sharedCommitCapSwap: state.sharedCommitCapSwap,
          });
          if (state.clicks) {
            nodes.push({
              nodeId: '98',
              parentId: '1',
              role: { value: 'StaticText' },
              name: { value: `clicks:${state.clicks}` },
            });
            nodes[0].childIds = [...nodes[0].childIds, '98'];
          }
          return Promise.resolve({ nodes });
        }
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 2 });
        if (method === 'DOM.resolveNode') {
          const id = params.backendNodeId;
          return Promise.resolve({ object: { objectId: `hf-${id}` } });
        }
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('this.click()')) {
            state.clicks += 1;
            return Promise.resolve({ result: { value: { tag: 'BUTTON', text: 'p26' } } });
          }
          const objectId = String(params.objectId || '');
          const backend = Number(objectId.replace('hf-', '')) || 301;
          if (backend === 399) {
            return Promise.resolve({
              result: { value: { x: 8, y: 80, w: 80, h: 24, position: '', tag: 'BUTTON', text: 'p26' } },
            });
          }
          const file = state.files.find(item => item.backend === backend) || state.files[0];
          return Promise.resolve({
            result: {
              value: {
                x: 24,
                y: file.y - state.scrollY,
                w: 160,
                h: 22,
                position: '',
                tag: 'A',
                text: file.name,
              },
            },
          });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
    return { cdp, state };
  }

  function comfyMeta(scrollY) {
    return JSON.stringify({
      title: 'MiniMax Music 3 - ComfyUI',
      url: COMFY_URL,
      contentType: 'text/html',
      vw: 1042,
      vh: 900,
      scrollY,
      scrollMax: 1800,
      counts: { a: 3 },
      focused: 'none',
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
      visibleControls: [{
        tag: 'a',
        role: 'link',
        label: 'API Reference',
        clickable: true,
        rect: { x: 16, y: 220 - scrollY, w: 140, h: 22 },
        selector: 'a[href="#api"]',
        hints: { id: '', classes: [] },
      }],
    });
  }

  function createComfyPage() {
    const state = { scrollY: 0 };
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'main-frame', url: COMFY_URL } } });
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('scrollBy')) {
            state.scrollY += 80;
            return Promise.resolve({ result: { value: JSON.stringify({ x: 0, y: state.scrollY }) } });
          }
          if (expr.includes("resolve('stable')") || expr.includes('MutationObserver')) {
            return Promise.resolve({ result: { value: 'stable' } });
          }
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({ result: { value: comfyMeta(state.scrollY) } });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({
            nodes: [
              { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'MiniMax Music 3' }, childIds: ['10'] },
              { nodeId: '10', parentId: '1', role: { value: 'main' }, name: { value: '' }, childIds: ['20'] },
              {
                nodeId: '20',
                parentId: '10',
                role: { value: 'link' },
                name: { value: 'API Reference' },
                backendDOMNodeId: 401,
              },
            ],
          });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'comfy-401' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          return Promise.resolve({
            result: {
              value: {
                x: 16,
                y: 220 - state.scrollY,
                w: 140,
                h: 22,
                position: '',
                tag: 'A',
                text: 'API Reference',
              },
            },
          });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
    return { cdp, state };
  }

  function scrollTarget() {
    return {
      input: 'down 80',
      resolvedBy: 'scroll',
      label: 'down',
      commandArgs: ['down', '80'],
    };
  }

  function clickJsTarget() {
    return {
      input: '#p26btn',
      resolvedBy: 'selector-or-ref',
      label: '#p26btn',
      commandArgs: ['--js', '#p26btn'],
    };
  }

  async function leftoverGoldenPath(cdp, store, refMap, refState, {
    targetId: _targetId = HF_TARGET_ID,
    prefix = HF_PREFIX,
  } = {}) {
    const dump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: prefix },
      refState,
    );
    expect(dump).toMatch(/^Page: /m);
    expect(store.snapshotOpts.cursorInteractive).toBe(true);
    expect(store.snapshotOpts.maxDepth).toBe(8);
    expect(T.isLeftoverFeedCardsSettle(dump, store.snapshotOpts, scrollTarget())).toBe(false);
    expect(T.isLeftoverDefaultAxScrollSettle(dump, store.snapshotOpts, scrollTarget())).toBe(true);
    expect(T.shouldCaptureTopLevelActionSettle(store.snapshotOpts, dump, scrollTarget())).toBe(false);
    expect(T.actionSettleBaseline(dump, store.snapshotOpts, scrollTarget()).output).toBe(dump);
    return dump;
  }

  async function recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState, targetId = HF_TARGET_ID) {
    const baselineFromTarget = T.baselineOutputForActionTarget(refState, store.output, actionTarget);
    let settleBaseline = T.actionSettleBaseline(
      baselineFromTarget,
      store.snapshotOpts || null,
      actionTarget,
    );
    if (
      !settleBaseline.output
      && T.shouldCaptureTopLevelActionSettle(
        store.snapshotOpts,
        baselineFromTarget,
        actionTarget,
      )
    ) {
      const topLevelOpts = T.actionObservationPerceiveOpts(targetId, {
        ...(settleBaseline.opts || {}),
        frameRef: null,
      });
      const before = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        topLevelOpts,
        refState,
      );
      settleBaseline = {
        output: before,
        opts: T.perceiveSnapshotOpts(topLevelOpts),
      };
    }
    return settleBaseline;
  }

  async function observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState, targetId = HF_TARGET_ID) {
    if (!settleBaseline.output) {
      return T.noBaselineActionDiffText();
    }
    return T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(targetId, actionTarget, settleBaseline.output, settleBaseline.opts),
      refState,
    );
  }

  it('#295 leftover golden-path AX is a scroll settle shape, not a cards recapture', () => {
    const dump = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 0/2400 (0%) | Focused: none',
      'Interactive: 3 a',
      'Console: clean',
      'Coords: top-level viewport CSS px',
      '',
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,180 160×22)',
    ].join('\n');
    const snapshotOpts = T.perceiveSnapshotOpts({ cursorInteractive: true, maxDepth: 8 });
    const scroll = scrollTarget();
    expect(T.isLeftoverDefaultAxScrollSettle(dump, snapshotOpts, scroll)).toBe(true);
    expect(T.shouldCaptureTopLevelActionSettle(snapshotOpts, dump, scroll)).toBe(false);
    const settled = T.actionSettleBaseline(dump, snapshotOpts, scroll);
    expect(settled.output).toBe(dump);
    expect(T.actionSettleObserveOpts(HF_TARGET_ID, scroll, settled.output, settled.opts).cards).toBe(false);
    expect(T.actionSettleObserveOpts(HF_TARGET_ID, scroll, settled.output, settled.opts).cursorInteractive).toBe(true);
    expect(T.actionSettleObserveOpts(HF_TARGET_ID, scroll, settled.output, settled.opts).maxDepth).toBe(8);

    const cardsDump = 'chrome-cdp-ex.cards.v1  2 cards  virtualized\n@1  @SY239434  first';
    expect(T.isLeftoverDefaultAxScrollSettle(cardsDump, T.perceiveSnapshotOpts({ cards: true }), scroll)).toBe(false);
    const click = clickJsTarget();
    expect(T.isLeftoverDefaultAxScrollSettle(dump, snapshotOpts, click)).toBe(false);
  });

  it('#295 leftover perceive -C -d 8 then scroll is no-change / continue, Next -C -d 8, not @ref rect chrome', async () => {
    const { cdp, state } = createHfPage();
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/LICENSE {2}@1 {2}\(24,180 160×22\)/);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;

    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(settleBaseline.opts.cursorInteractive).toBe(true);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);

    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    expect(state.scrollY).toBe(80);

    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(after).toMatch(/Scroll: 80\/2400/);
    expect(after).not.toMatch(/--- Removed/);
    expect(after).not.toMatch(/\(24,180/);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);

    if (T.isLeftoverDefaultAxScrollSettle(leftoverDump, store.snapshotOpts, actionTarget)) {
      actionTarget.expectedOutcome = actionTarget.expectedOutcome || 'leftover-ax-scroll-no-change';
    }
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Outcome: no-change/);
    expect(text).not.toMatch(/Outcome: changed/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(text).not.toMatch(/record-actions/);
  });

  it('#295 leftover -C -d 8 then scroll that adds a file is Outcome: changed', async () => {
    const { cdp, state } = createHfPage();
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    await leftoverGoldenPath(cdp, store, refMap, refState);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    state.files = [...DEFAULT_FILES, ADDED_FILE];
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/tokenizer\.json/);
    expect(after).not.toMatch(/no changes detected in AX tree/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(result.outcome.status).toBe('changed');
    expect(T.isExpectedNoChange(actionTarget, after, 'scroll')).toBe(true);
  });

  it('#295 leftover Comfy perceive -C -d 8 then scroll ignores heading @ref rect chrome', async () => {
    const { cdp, state } = createComfyPage();
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState, {
      targetId: COMFY_TARGET_ID,
      prefix: COMFY_PREFIX,
    });
    expect(leftoverDump).toMatch(/API Reference {2}@1 {2}\(16,220 140×22\)/);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(
      cdp, store, actionTarget, refMap, refState, COMFY_TARGET_ID,
    );
    await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(state.scrollY).toBe(80);
    const after = await observeActionDiffForTarget(
      cdp, store, actionTarget, settleBaseline, refMap, refState, COMFY_TARGET_ID,
    );
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: COMFY_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Next: cdp perceive 0D34570A -C -d 8/);
    expect(text).not.toMatch(/cdp report 0D34570A --format json/);
  });

  it('#295 leftover -C -d 8 then mutating click --js still Outcome: changed', async () => {
    const { cdp, state } = createHfPage({ clicks: 6 });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    await leftoverGoldenPath(cdp, store, refMap, refState);
    const actionTarget = clickJsTarget();
    expect(T.isLeftoverDefaultAxScrollSettle(store.output, store.snapshotOpts, actionTarget)).toBe(false);
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toContain('[StaticText] clicks:6');
    const dispatchText = await T.jsClickStr(cdp, 'sid', '#p26btn', refMap, refState);
    expect(dispatchText).toMatch(/JS-clicked <BUTTON>/);
    expect(state.clicks).toBe(7);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    expect(after).toMatch(/\+\s+\[StaticText\] clicks:7/);
  });

  it('#297 leftover -C -d 8 then scroll fold-tag-only [navigation] Main is no-change / Next -C -d 8', async () => {
    const { cdp } = createHfPage({ foldTag: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/\[navigation\] Main {2}603×28px/);
    expect(leftoverDump).not.toMatch(/↑above fold/);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(after).not.toMatch(/--- Removed/);
    expect(after).not.toMatch(/↑above fold/);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
  });

  it('#297 leftover -C -d 8 then scroll Visible-control cap-swap is changed / compact / Next -C -d 8', async () => {
    const { cdp } = createHfPage({ capSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/Hugging Face/);
    expect(leftoverDump).toMatch(/\[navigation\] Main {2}603×28px/);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/Visible-control cap swap: 8 left, 8 entered/);
    expect(after).toContain('- Hugging Face');
    expect(after).toContain('+ MiniMaxAI');
    expect(after).not.toMatch(/--- Removed \(9\)/);
    expect(after).not.toMatch(/a role=link "Hugging Face"/);
    expect(after).not.toMatch(/\[navigation\] Main/);
    expect(after).not.toMatch(/LICENSE/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap: 8 left, 8 entered/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(text).not.toMatch(/record-actions/);
  });

  it('#297 leftover -C -d 8 cap-swap plus a new file still prints tokenizer.json', async () => {
    const { cdp, state } = createHfPage({ capSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    await leftoverGoldenPath(cdp, store, refMap, refState);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    state.files = [...DEFAULT_FILES, ADDED_FILE];
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/tokenizer\.json/);
    expect(after).toMatch(/Visible-control cap swap: 8 left, 8 entered/);
    expect(after).not.toMatch(/a role=link "Hugging Face"/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('changed');
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
  });

  it('#299 leftover -C -d 8 then scroll cap-swap samples skip unlabeled tags and drop Hint --since-action', async () => {
    const { cdp } = createHfPage({ noisyCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/img "img" \[clickable\]/);
    expect(leftoverDump).toMatch(/div "div" \[clickable\]/);
    expect(leftoverDump).toMatch(/a role=link "link" \[clickable\]/);
    expect(leftoverDump).toMatch(/Hugging Face/);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/Visible-control cap swap: \d+ left, \d+ entered/);
    const removedSamples = [...after.matchAll(/^- (.+)$/gm)].map(match => match[1]);
    const addedSamples = [...after.matchAll(/^\+ (.+)$/gm)].map(match => match[1]);
    expect(removedSamples[0]).toBe('Hugging Face');
    expect(addedSamples[0]).toBe('MiniMaxAI');
    expect(after).toContain('- Hugging Face');
    expect(after).toContain('+ MiniMaxAI');
    expect(removedSamples).not.toEqual(expect.arrayContaining(['img', 'div', 'link', 'a']));
    expect(addedSamples).not.toEqual(expect.arrayContaining(['img', 'div', 'link', 'a']));
    expect(after).not.toMatch(/^[-+] (?:img|div|link|a)\b/m);
    expect(after).not.toMatch(/img\.logo|div\.nav-icon|img\.hero|div\.body-icon/);
    expect(after).not.toMatch(/--- Removed \(\d+\)/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 80)',
    });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.nextHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap:/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/perceive --since-action/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/Hint: Use perceive --since-action/);
  });

  it('#301 leftover -C -d 8 then scroll cap-swap drops generic Recovery hint and stays changed', async () => {
    const { cdp } = createHfPage({ noisyCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/^Page: /m);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/Visible-control cap swap: \d+ left, \d+ entered/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap:/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(receipt).toMatch(/Outcome: changed/);
    expect(receipt).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
  });

  it('#303 leftover -C -d 8 then scroll drops signed-commit / time GMT Added chrome and stays changed', async () => {
    const { cdp } = createHfPage({ noisyCapSwap: true, titleChrome: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/^Page: /m);
    expect(leftoverDump).not.toMatch(/This commit is signed/);
    const signedReceipt = T.formatVisibleControlLine({
      tag: 'span',
      label: 'This commit is signed and the signature is verified',
      title: 'This commit is signed and the signature is verified',
      selector: 'span[title="This commit is signed and the signature is verified"]',
      hints: { classes: ['mx-2', 'text-green-500', 'dark:text-green-600'] },
    });
    const timeReceipt = T.formatVisibleControlLine({
      tag: 'time',
      label: 'Fri, 14 Aug 2026 10:51:40 GMT',
      title: 'Fri, 14 Aug 2026 10:51:40 GMT',
      selector: 'time[title="Fri, 14 Aug 2026 10:51:40 GMT"]',
      hints: { classes: ['ml-auto', 'hidden', 'flex-none'] },
    });
    expect(signedReceipt).toBe(
      'span "This commit is signed and the signature is verified" span[title="This commit is signed and the signature is verified"] .mx-2.text-green-500.dark:text-green-600',
    );
    expect(timeReceipt).toBe(
      'time "Fri, 14 Aug 2026 10:51:40 GMT" time[title="Fri, 14 Aug 2026 10:51:40 GMT"] .ml-auto.hidden.flex-none',
    );
    const signedDump = T.formatVisibleControlLine(hfTitleChromeControls()[0]);
    const timeDump = T.formatVisibleControlLine(hfTitleChromeControls()[1]);
    expect(signedDump).toContain('(400,120 18×18)');
    expect(signedDump).toContain('span[title="This commit is signed and the signature is verified"]');
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    const afterDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      { output: leftoverDump, snapshotOpts: store.snapshotOpts },
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: HF_PREFIX },
      refState,
    );
    expect(afterDump).toContain(signedDump);
    expect(afterDump).toContain(timeDump);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).not.toMatch(/\+\+\+ Added/);
    expect(after).not.toMatch(/^\+ .*span\[title=/m);
    expect(after).not.toMatch(/^\+ .*time\[title=/m);
    expect(after).not.toMatch(/^\+ .*This commit is signed/m);
    expect(after).not.toMatch(/^\+ .*10:51:40 GMT/m);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap:/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/\+\+\+ Added/);
    expect(text).not.toMatch(/span\[title=/);
    expect(text).not.toMatch(/This commit is signed/);
    expect(receipt).toMatch(/Outcome: changed/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/\+\+\+ Added/);
  });

  it('#303 leftover -C -d 8 title chrome plus a new file still prints tokenizer.json', async () => {
    const { cdp, state } = createHfPage({ noisyCapSwap: true, titleChrome: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    await leftoverGoldenPath(cdp, store, refMap, refState);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    state.files = [...DEFAULT_FILES, ADDED_FILE];
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/tokenizer\.json/);
    expect(after).toMatch(/Visible-control cap swap:/);
    expect(after).not.toMatch(/\+\+\+ Added \(\d+\):[\s\S]*This commit is signed/);
    expect(after).not.toMatch(/^\+ .*span\[title=/m);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('changed');
    expect(text).toMatch(/tokenizer\.json/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/span\[title=/);
  });

  it('#305 leftover -C -d 8 then scroll cap-swap samples skip relative-time / GMT and stay changed', async () => {
    const { cdp } = createHfPage({ timestampCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/ryanlee-dev/);
    expect(leftoverDump).toMatch(/assets/);
    const relativeDump = T.formatVisibleControlLine(hfTimestampChromeControls()[0]);
    const gmtDump = T.formatVisibleControlLine(hfTimestampChromeControls()[1]);
    expect(relativeDump).toBe('a role=link "2 days ago" [clickable] (720,184 72×16) a.truncate .truncate');
    expect(gmtDump).toContain('time "Thu, 13 Aug 2026 15:18:27 GMT" [clickable]');
    expect(gmtDump).toContain('time[title="Thu, 13 Aug 2026 15:18:27 GMT"]');
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    const afterDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      { output: leftoverDump, snapshotOpts: store.snapshotOpts },
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: HF_PREFIX },
      refState,
    );
    expect(afterDump).toContain(relativeDump);
    expect(afterDump).toContain(gmtDump);
    expect(afterDump).toMatch(/condition_encoder/);
    expect(afterDump).toMatch(/config\.json/);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(after).toContain('- ryanlee-dev');
    expect(after).toContain('+ condition_encoder');
    expect(after).toContain('+ Add diffusers weights (modular pipeline) (#2)');
    expect(after).toContain('+ config.json');
    const addedSamples = [...after.matchAll(/^\+ (.+)$/gm)].map(match => match[1]);
    expect(addedSamples).toEqual([
      'condition_encoder',
      'Add diffusers weights (modular pipeline) (#2)',
      'config.json',
    ]);
    expect(after).not.toMatch(/^\+ 2 days ago$/m);
    expect(after).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);
    expect(after).not.toMatch(/\+\+\+ Added/);
    expect(after).not.toMatch(/time\[title=/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(text).toMatch(/\+ config\.json/);
    expect(text).not.toMatch(/^\+ 2 days ago$/m);
    expect(text).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/\+\+\+ Added/);
    expect(receipt).toMatch(/Outcome: changed/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/^\+ 2 days ago$/m);
    expect(receipt).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);
  });

  it('#305 leftover -C -d 8 timestamp samples plus a new file still prints tokenizer.json', async () => {
    const { cdp, state } = createHfPage({ timestampCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    await leftoverGoldenPath(cdp, store, refMap, refState);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    state.files = [...DEFAULT_FILES, ADDED_FILE];
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/tokenizer\.json/);
    expect(after).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(after).not.toMatch(/^\+ 2 days ago$/m);
    expect(after).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('changed');
    expect(text).toMatch(/tokenizer\.json/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/^\+ 2 days ago$/m);
  });

  it('#307 leftover -C -d 8 then scroll cap-swap samples skip a shared commit title on both sides', async () => {
    const { cdp } = createHfPage({ sharedCommitCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/condition_encoder/);
    expect(leftoverDump).toMatch(/figures/);
    expect(leftoverDump).toMatch(/tokenizer\.json/);
    const commitLeft = T.formatVisibleControlLine(sharedCommitCapSwapChrome()[1]);
    const commitEntered = T.formatVisibleControlLine(sharedCommitCapSwapContent()[1]);
    expect(commitLeft).toBe(
      'a role=link "Add diffusers weights (modular pipeline) (#2)" [clickable] (24,128 160×22) a[href="/MiniMaxAI/MiniMax-Music3/commit/left"]',
    );
    expect(commitEntered).toBe(
      'a role=link "Add diffusers weights (modular pipeline) (#2)" [clickable] (24,128 160×22) a[href="/MiniMaxAI/MiniMax-Music3/commit/entered"]',
    );
    expect(leftoverDump).toMatch(
      /a role=link "Add diffusers weights \(modular pipeline\) \(#2\)" \[clickable\] \(24,128 160×22\)(?: @\d+)? a\[href="\/MiniMaxAI\/MiniMax-Music3\/commit\/left"\]/,
    );
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    const afterDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      { output: leftoverDump, snapshotOpts: store.snapshotOpts },
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: HF_PREFIX },
      refState,
    );
    expect(afterDump).toMatch(
      /a role=link "Add diffusers weights \(modular pipeline\) \(#2\)" \[clickable\] \(24,128 160×22\)(?: @\d+)? a\[href="\/MiniMaxAI\/MiniMax-Music3\/commit\/entered"\]/,
    );
    expect(afterDump).toMatch(/language_model/);
    expect(afterDump).toMatch(/qwen_7B/);
    expect(afterDump).toMatch(/speech_tokenizer/);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/Visible-control cap swap: 4 left, 4 entered/);
    expect(after).toContain('- condition_encoder');
    expect(after).toContain('- figures');
    expect(after).toContain('- tokenizer.json');
    expect(after).toContain('+ language_model');
    expect(after).toContain('+ qwen_7B');
    expect(after).toContain('+ speech_tokenizer');
    const removedSamples = [...after.matchAll(/^- (.+)$/gm)].map(match => match[1]);
    const addedSamples = [...after.matchAll(/^\+ (.+)$/gm)].map(match => match[1]);
    expect(removedSamples).toEqual([
      'condition_encoder',
      'figures',
      'tokenizer.json',
    ]);
    expect(addedSamples).toEqual([
      'language_model',
      'qwen_7B',
      'speech_tokenizer',
    ]);
    expect(after).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(after).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(after).not.toMatch(/\+\+\+ Added/);
    expect(after).not.toMatch(/span\[title=/);
    expect(after).not.toMatch(/time\[title=/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap: 4 left, 4 entered/);
    expect(text).toMatch(/- tokenizer\.json/);
    expect(text).toMatch(/\+ speech_tokenizer/);
    expect(text).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(text).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/\+\+\+ Added/);
    expect(receipt).toMatch(/Outcome: changed/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(receipt).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
  });

  it('#307 leftover -C -d 8 shared commit samples plus a new file still prints tokenizer.json', async () => {
    const { cdp, state } = createHfPage({ sharedCommitCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    await leftoverGoldenPath(cdp, store, refMap, refState);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    state.files = [...DEFAULT_FILES, ADDED_FILE];
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/\[link\] tokenizer\.json/);
    expect(after).toMatch(/Visible-control cap swap: 4 left, 4 entered/);
    expect(after).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(after).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('changed');
    expect(text).toMatch(/\[link\] tokenizer\.json/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(text).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
  });
});

describe('issue #286 hover settle baseline', () => {
  const TARGET_ID = '62E1DF195EAC5A1A211792636BAE8A07';
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  function pageMeta() {
    return JSON.stringify({
      title: 'Example Domain',
      url: 'https://example.com/',
      contentType: 'text/html',
      vw: 1042,
      vh: 632,
      scrollY: 0,
      scrollMax: 0,
      counts: { span: 1 },
      focused: 'none',
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
      visibleControls: [{
        tag: 'span',
        role: 'button',
        label: 'p23hover',
        clickable: true,
        rect: { x: 8, y: 80, w: 80, h: 24 },
        selector: 'span#p23hover',
        hints: { id: 'p23hover', classes: [] },
      }],
    });
  }

  function axNodes(hovers) {
    return [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example Domain' }, childIds: ['2', '3', '4'] },
      { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Example Domain' } },
      { nodeId: '3', parentId: '1', role: { value: 'button' }, name: { value: 'p23hover' }, backendDOMNodeId: 23 },
      { nodeId: '4', parentId: '1', role: { value: 'StaticText' }, name: { value: `hover:${hovers}` } },
    ];
  }

  function isWaitForSettleExpr(expr) {
    return typeof expr === 'string'
      && expr.includes("resolve('stable')")
      && expr.includes('setTimeout(done, 350)');
  }

  function isHoverMutationExpr(expr) {
    return typeof expr === 'string'
      && expr.includes('chrome-cdp-ex.hover-mutation.v1')
      && expr.includes('hover-changed');
  }

  function createPicky23Page({
    hovers = 0,
    delayHoverUntilSettle = false,
    idleQuiet = false,
    hangMutation = false,
  } = {}) {
    const state = { hovers, pendingHover: false };
    const deferHover = delayHoverUntilSettle || idleQuiet || hangMutation;
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'main-frame', url: 'https://example.com/' } } });
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (isHoverMutationExpr(expr)) {
            if (hangMutation) {
              // Live Chrome 151: mutation never arrives inside HOVER_MUTATION_TIMEOUT_MS.
              // Sitting this wait is the paid residual after #289 discard.
              return new Promise(resolve => {
                setTimeout(
                  () => resolve({ result: { value: 'timeout' } }),
                  T.HOVER_MUTATION_TIMEOUT_MS,
                );
              });
            }
            if (state.pendingHover && !idleQuiet) {
              state.hovers += 1;
              state.pendingHover = false;
              return Promise.resolve({ result: { value: 'hover-changed' } });
            }
            return Promise.resolve({ result: { value: 'timeout' } });
          }
          if (isWaitForSettleExpr(expr) || expr.includes('MutationObserver')) {
            // waitForSettle's 350ms quiet is not the hover mutation. Applying
            // pendingHover here would hide the live Chrome 151 residual.
            return Promise.resolve({ result: { value: 'stable' } });
          }
          if (expr.includes('scrollBy')) {
            return Promise.resolve({ result: { value: '{"x":0,"y":0}' } });
          }
          if (expr.includes('#p23hover') && expr.includes('rect.width / 2')) {
            return Promise.resolve({ result: { value: { ok: true, x: 48, y: 92, tag: 'SPAN' } } });
          }
          return Promise.resolve({ result: { value: pageMeta() } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({ nodes: axNodes(state.hovers) });
        }
        if (method === 'Input.dispatchMouseEvent') {
          if (params.type === 'mouseMoved') {
            if (deferHover) state.pendingHover = true;
            else state.hovers += 1;
          }
          return Promise.resolve({});
        }
        if (method === 'DOM.getDocument') {
          return Promise.resolve({ root: { nodeId: 1 } });
        }
        if (method === 'DOM.querySelector') {
          return Promise.resolve({ nodeId: 23 });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'p23-hover' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          return Promise.resolve({ result: { value: { connected: true, x: 8, y: 80, w: 80, h: 24, tag: 'SPAN' } } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
    return { cdp, state };
  }

  function scrollTarget() {
    return {
      input: 'down',
      resolvedBy: 'scroll',
      label: 'down',
    };
  }

  async function settleScrollReceipt(cdp, store, { refreshHover = false } = {}) {
    const refMap = new Map();
    const refState = {};
    const before = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { targetPrefix: '62E1DF19' },
      refState,
    );
    expect(before).toContain('[StaticText] hover:0');
    let hoverText;
    if (refreshHover) {
      expect(typeof T.rememberHoverSettleBaseline).toBe('function');
      await T.rememberHoverSettleBaseline(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        refState,
        TARGET_ID,
        async () => {
          hoverText = await T.hoverStr(cdp, 'sid', '#p23hover', refMap, refState);
        },
      );
    } else {
      hoverText = await T.hoverStr(cdp, 'sid', '#p23hover', refMap, refState);
    }
    expect(hoverText).toMatch(/Hovering over <SPAN>/);
    const actionTarget = scrollTarget();
    const settleBaseline = T.actionSettleBaseline(store.output, store.snapshotOpts, actionTarget);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 0)');
    const after = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts),
      refState,
    );
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    return { hoverText, dispatchText, after, result, text: T.formatActionText(result), settleBaseline };
  }

  it('#286 hover then no-op scroll must not claim + hover text as scroll change', async () => {
    const { cdp, state } = createPicky23Page({ hovers: 0 });
    const store = { output: null, snapshotOpts: null };
    const liar = await settleScrollReceipt(cdp, store, { refreshHover: false });
    expect(state.hovers).toBe(1);
    expect(liar.after).toMatch(/\+\s+\[StaticText\] hover:1/);
    expect(liar.result.outcome.status).toBe('changed');

    const honestStore = { output: null, snapshotOpts: null };
    const { cdp: honestCdp, state: honestState } = createPicky23Page({ hovers: 0 });
    const honest = await settleScrollReceipt(honestCdp, honestStore, { refreshHover: true });
    expect(honestState.hovers).toBe(1);
    expect(honest.settleBaseline.output).toContain('[StaticText] hover:1');
    expect(honestCdp.calls.some(call => (
      call.method === 'Runtime.evaluate'
      && isHoverMutationExpr(String(call.params.expression || ''))
    ))).toBe(false);
    expect(honest.after).toMatch(/no changes detected/i);
    expect(honest.after).not.toMatch(/\+\s+\[StaticText\] hover:1/);
    expect(honest.result.outcome.status).toBe('no-change');
    expect(honest.text).not.toMatch(/Outcome: changed/);
  });

  it('#286 perceive then the same no-op scroll stays no-change', async () => {
    const { cdp, state } = createPicky23Page({ hovers: 1 });
    const store = { output: null, snapshotOpts: null };
    const actionTarget = scrollTarget();
    const before = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { targetPrefix: '62E1DF19' },
      {},
    );
    expect(before).toContain('[StaticText] hover:1');
    const settleBaseline = T.actionSettleBaseline(store.output, store.snapshotOpts, actionTarget);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 0)');
    const after = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      T.actionSettleObserveOpts(TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts),
      {},
    );
    expect(state.hovers).toBe(1);
    expect(after).toMatch(/no changes detected/i);
    expect(after).not.toMatch(/\+\s+\[StaticText\] hover:1/);
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(result.outcome.status).toBe('no-change');
  });

  it('#286 hover handler refreshes last-perceive settle baseline', () => {
    const src = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/hover: async args =>[\s\S]{0,800}rememberHoverSettleBaseline\(/);
    expect(src).toMatch(/hover: async args =>[\s\S]{0,1200}hoverStr\(/);
    expect(src).not.toMatch(
      /async function rememberHoverSettleBaseline[\s\S]{0,2800}waitForHoverDomChange\(/,
    );
    expect(src).toMatch(
      /async function rememberHoverSettleBaseline[\s\S]{0,2800}if \(hoverRecaptureShowsChange\(before, lastPerceiveStore\.output\)\) \{\s*return;\s*\}\s*discardHoverIdleBaseline\(/,
    );
    expect(src).not.toMatch(
      /async function rememberHoverSettleBaseline[\s\S]{0,800}await waitForSettle\(cdp, sid\);\s*await perceiveStr\(/,
    );
    expect(T.HOVER_MUTATION_TIMEOUT_MS).toBe(3000);
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBe(250);
  });

  it('#291 idle recapture must discard without sitting HOVER_MUTATION_TIMEOUT_MS', async () => {
    const { cdp, state } = createPicky23Page({ hovers: 0, hangMutation: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const before = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { targetPrefix: '62E1DF19' },
      refState,
    );
    expect(before).toContain('[StaticText] hover:0');
    const started = Date.now();
    await T.rememberHoverSettleBaseline(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      refState,
      TARGET_ID,
      async () => {
        await T.hoverStr(cdp, 'sid', '#p23hover', refMap, refState);
      },
    );
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(1000);
    expect(cdp.calls.some(call => (
      call.method === 'Runtime.evaluate'
      && isHoverMutationExpr(String(call.params.expression || ''))
    ))).toBe(false);
    expect(state.pendingHover).toBe(true);
    expect(state.hovers).toBe(0);
    expect(store.output).toBeNull();

    state.hovers += 1;
    state.pendingHover = false;
    const actionTarget = scrollTarget();
    const settleBaseline = T.actionSettleBaseline(store.output, store.snapshotOpts, actionTarget);
    expect(settleBaseline.output).toBeNull();
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 0)');
    const after = T.noBaselineActionDiffText();
    expect(after).toMatch(/no changes detected/i);
    expect(after).not.toMatch(/\+\s+\[StaticText\] hover:1/);
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(result.outcome.status).toBe('no-change');
  });

  it('#286 recapture must not write the idle tree while hover is still pending', async () => {
    const { cdp, state } = createPicky23Page({ hovers: 0, idleQuiet: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const before = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { targetPrefix: '62E1DF19' },
      refState,
    );
    expect(before).toContain('[StaticText] hover:0');
    await T.rememberHoverSettleBaseline(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      refState,
      TARGET_ID,
      async () => {
        await T.hoverStr(cdp, 'sid', '#p23hover', refMap, refState);
      },
    );
    expect(state.pendingHover).toBe(true);
    expect(state.hovers).toBe(0);
    expect(String(store.output || '')).not.toContain('[StaticText] hover:0');
    expect(store.output).toBeNull();

    if (state.pendingHover) {
      state.hovers += 1;
      state.pendingHover = false;
    }
    const actionTarget = scrollTarget();
    const settleBaseline = T.actionSettleBaseline(store.output, store.snapshotOpts, actionTarget);
    expect(settleBaseline.output).toBeNull();
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 0)');
    const after = settleBaseline.output
      ? await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        T.actionSettleObserveOpts(TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts),
        refState,
      )
      : T.noBaselineActionDiffText();
    expect(after).toMatch(/no changes detected/i);
    expect(after).not.toMatch(/\+\s+\[StaticText\] hover:1/);
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(result.outcome.status).toBe('no-change');
  });

  it('#286 leftover -C -d 8 vs default idle AX on timeout must discard, not KEEP', async () => {
    const leftoverOpts = {
      targetPrefix: '62E1DF19',
      cursorInteractive: true,
      maxDepth: 8,
    };
    const { cdp, state } = createPicky23Page({ hovers: 0, idleQuiet: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftover = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      leftoverOpts,
      refState,
    );
    expect(leftover).toContain('[StaticText] hover:0');
    expect(leftover).toContain('[Visible controls]');
    expect(store.snapshotOpts).toMatchObject({ cursorInteractive: true, maxDepth: 8 });

    const { cdp: defaultCdp } = createPicky23Page({ hovers: 0, idleQuiet: true });
    const defaultIdle = await T.perceiveStr(
      defaultCdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      { output: null, snapshotOpts: null },
      { targetPrefix: '62E1DF19' },
      {},
    );
    expect(defaultIdle).toContain('[StaticText] hover:0');
    expect(defaultIdle).not.toContain('[Visible controls]');
    expect(T.hoverRecaptureShowsChange(leftover, defaultIdle)).toBe(true);

    await T.rememberHoverSettleBaseline(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      refState,
      TARGET_ID,
      async () => {
        await T.hoverStr(cdp, 'sid', '#p23hover', refMap, refState);
      },
    );
    expect(state.pendingHover).toBe(true);
    expect(state.hovers).toBe(0);
    expect(store.output).toBeNull();
  });
});

function pageSnapshotValue(overrides = {}) {
  return JSON.stringify({
    title: 'Example Domain',
    url: 'https://example.com/',
    contentType: 'text/html',
    vw: 1042,
    vh: 632,
    scrollY: 0,
    scrollMax: 0,
    counts: { button: 1, 'input[text]': 1, 'input[hidden]': 1, div: 2 },
    focused: 'none',
    layoutMap: {},
    styleHints: {},
    cursorInteractives: [],
    visibleControls: [{
      tag: 'input',
      role: 'textbox',
      label: 'oin',
      clickable: true,
      rect: { x: 8, y: 80, w: 185, h: 21 },
      selector: 'input#oin',
      hints: { id: 'oin', classes: [] },
    }],
    ...overrides,
  });
}

function callFunctionOnForFill(params = {}, filledText = 'hello-oin') {
  const decl = String(params.functionDeclaration || '');
  if (decl.includes('ownerDocumentGetter') && !decl.includes('requestAnimationFrame')) {
    return { result: { value: { connected: true } } };
  }
  if (decl.includes('cdpFillLiveValue')) {
    return { result: { value: { ok: true, cdpFillLiveValue: true, tag: 'INPUT', value: filledText, textContent: filledText } } };
  }
  if (decl.includes('fillable') || decl.includes('isContentEditable') || decl.includes('TEXTAREA')) {
    return { result: { value: { ok: true, fillable: true, tag: 'INPUT', type: 'text', role: '' } } };
  }
  if (decl.includes('getBoundingClientRect')) {
    if (params.objectId === 'input-object') {
      return { result: { value: { x: 8, y: 80, w: 185, h: 21, position: '' } } };
    }
    if (params.objectId === 'button-object') {
      return { result: { value: { x: 8, y: 8, w: 80, h: 24, position: '' } } };
    }
    if (params.objectId === 'frame-owner') {
      return { result: { value: { x: 218, y: 275, w: 400, h: 200 } } };
    }
    return { result: { value: { x: 0, y: 0, w: 0, h: 0, position: '' } } };
  }
  return { result: { value: { x: 0, y: 0, w: 0, h: 0, position: '' } } };
}

function framedUnnamedInputCdp({
  frameId = 'child-frame',
  axOmitsInput = true,
  nested = false,
  filledText = 'hello-oin',
  describeNodeIds = { 'button-object': 201, 'input-object': 202 },
} = {}) {
  const methods = [];
  const childFrames = nested
    ? [{
        frame: { id: 'outer-frame', parentId: 'main-frame', name: 'p16outer', url: 'about:srcdoc' },
        childFrames: [{
          frame: { id: frameId, parentId: 'outer-frame', name: 'p16inner', url: 'about:srcdoc' },
          childFrames: [],
        }],
      }]
    : [{
        frame: { id: frameId, parentId: 'main-frame', name: 'p16outer', url: 'about:srcdoc' },
        childFrames: [],
      }];
  const axNodes = axOmitsInput
    ? [
        { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'iframe' }, childIds: ['2'] },
        { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'outer-btn' }, backendDOMNodeId: 201 },
      ]
    : [
        { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'iframe' }, childIds: ['2', '3'] },
        { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'outer-btn' }, backendDOMNodeId: 201 },
        { nodeId: '3', parentId: '1', role: { value: 'textbox' }, name: { value: '' }, backendDOMNodeId: 202 },
      ];
  const listed = [
    { chromeCdpDomInteractiveList: true, index: 1, tag: 'button', type: '', id: '', name: 'outer-btn', role: 'button', hidden: false },
    { chromeCdpDomInteractiveList: true, index: 2, tag: 'input', type: 'text', id: 'oin', name: '', role: 'textbox', hidden: false },
  ];
  const cdp = {
    methods,
    send(method, params = {}) {
      methods.push({ method, params });
      if (method === 'Page.getFrameTree') {
        return Promise.resolve({
          frameTree: {
            frame: { id: 'main-frame', url: 'https://example.com/' },
            childFrames,
          },
        });
      }
      if (method === 'Page.createIsolatedWorld') {
        return Promise.resolve({ executionContextId: 42 });
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('chromeCdpDomInteractiveList')) {
          return Promise.resolve({ result: { value: JSON.stringify(listed) } });
        }
        if (expr.includes("querySelectorAll('a, button, input, select, textarea')")) {
          const index = Number(/\[(\d+)\]/.exec(expr)?.[1] || 0);
          const objectId = index === 2 ? 'input-object' : 'button-object';
          return Promise.resolve({ result: { objectId } });
        }
        return Promise.resolve({ result: { value: pageSnapshotValue() } });
      }
      if (method === 'Accessibility.getFullAXTree') {
        expect(params.frameId).toBe(frameId);
        return Promise.resolve({ nodes: axNodes });
      }
      if (method === 'DOM.resolveNode') {
        if (params.backendNodeId === 202) return Promise.resolve({ object: { objectId: 'input-object' } });
        if (params.backendNodeId === 201) return Promise.resolve({ object: { objectId: 'button-object' } });
        if (params.backendNodeId === 333) return Promise.resolve({ object: { objectId: 'frame-owner' } });
        return Promise.resolve({ object: { objectId: 'other' } });
      }
      if (method === 'Runtime.callFunctionOn') {
        return Promise.resolve(callFunctionOnForFill(params, filledText));
      }
      if (method === 'DOM.getFrameOwner') {
        return Promise.resolve({ backendNodeId: 333 });
      }
      if (method === 'DOM.describeNode') {
        const backendNodeId = describeNodeIds[params.objectId];
        return Promise.resolve({ node: backendNodeId != null ? { backendNodeId } : {} });
      }
      if (method === 'Input.insertText') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
  return cdp;
}

describe('issue #261 framed perceive refs for unnamed inputs', () => {
  it('#261 unnamed framed textboxes stay in the AX dump and receive @fN:M', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'iframe' }, childIds: ['2', '3'] },
      { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'outer-btn' }, backendDOMNodeId: 201 },
      { nodeId: '3', parentId: '1', role: { value: 'textbox' }, name: { value: '' }, backendDOMNodeId: 202 },
    ];
    const refMap = new Map();
    const { treeLines } = T.buildPerceiveTree(nodes, { layoutMap: {}, styleHints: {} }, refMap);
    const qualified = T.qualifyFrameRefsInLines(treeLines, '@f2');
    const output = qualified.join('\n');
    expect(refMap.get(1)).toBe(201);
    expect(refMap.get(2)).toBe(202);
    expect(output).toContain('[button] outer-btn  @f2:1');
    expect(output).toMatch(/\[textbox\].*@f2:2/);
  });

  it('#261 synthesizes an AX node when getFullAXTree omits the framed input', () => {
    const axNodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'iframe' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'outer-btn' }, backendDOMNodeId: 201 },
    ];
    const merged = T.mergeMissingDomInteractiveAxNodes(axNodes, [
      { backendNodeId: 201, tag: 'button', role: 'button', name: 'outer-btn' },
      { backendNodeId: 202, tag: 'input', type: 'text', role: 'textbox', id: 'oin', name: '' },
    ]);
    const refMap = new Map();
    const { treeLines } = T.buildPerceiveTree(merged, { layoutMap: {}, styleHints: {} }, refMap);
    expect(refMap.size).toBe(2);
    expect(refMap.get(2)).toBe(202);
    expect(T.qualifyFrameRefsInLines(treeLines, '@f2').join('\n')).toMatch(/\[textbox\].*@f2:2/);
  });

  it('#261 -C frame coords match @fN:M / clickxy top-level viewport space and carry the ref', () => {
    const offset = { x: 218, y: 275 };
    const local = { x: 8, y: 80, w: 185, h: 21 };
    const viewport = T.offsetCssRect(local, offset);
    expect(viewport).toEqual({ x: 226, y: 355, w: 185, h: 21 });

    const control = T.attachRefToVisibleControl(
      { tag: 'input', role: 'textbox', label: 'oin', rect: viewport, selector: 'input#oin', hints: { id: 'oin' } },
      T.refAnnotationsFromTreeLines(['[textbox]  @f2:2  (226,355 185×21)']),
    );
    expect(control.ref).toBe('@f2:2');
    expect(T.formatVisibleControlLine(control)).toContain('@f2:2');
    expect(T.formatVisibleControlLine(control)).toContain('(226,355 185×21)');
    expect(T.nativeVisibleControlTag('input')).toBe(true);
  });

  it('#261 perceive --frame assigns @f2:2 to an unnamed srcdoc text input and offsets -C', async () => {
    const store = { output: null, snapshotOpts: null };
    const refState = {};
    const cdp = {
      send(method, params = {}) {
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({
            frameTree: {
              frame: { id: 'main-frame', url: 'https://example.com/' },
              childFrames: [{
                frame: { id: 'child-frame', parentId: 'main-frame', name: 'p16outer', url: 'about:srcdoc' },
                childFrames: [],
              }],
            },
          });
        }
        if (method === 'Page.createIsolatedWorld') {
          return Promise.resolve({ executionContextId: 42 });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({
            result: {
              value: JSON.stringify({
                title: 'Example Domain',
                url: 'https://example.com/',
                contentType: 'text/html',
                vw: 1042,
                vh: 632,
                scrollY: 0,
                scrollMax: 0,
                counts: { button: 1, 'input[text]': 1 },
                focused: 'none',
                layoutMap: {},
                styleHints: {},
                cursorInteractives: [],
                visibleControls: [{
                  tag: 'input',
                  role: 'textbox',
                  label: 'oin',
                  clickable: true,
                  rect: { x: 8, y: 80, w: 185, h: 21 },
                  selector: 'input#oin',
                  hints: { id: 'oin', classes: [] },
                }],
              }),
            },
          });
        }
        if (method === 'Accessibility.getFullAXTree') {
          expect(params.frameId).toBe('child-frame');
          return Promise.resolve({
            nodes: [
              { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'iframe' }, childIds: ['2', '3'] },
              { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'outer-btn' }, backendDOMNodeId: 201 },
              { nodeId: '3', parentId: '1', role: { value: 'textbox' }, name: { value: '' }, backendDOMNodeId: 202 },
            ],
          });
        }
        if (method === 'DOM.resolveNode') {
          if (params.backendNodeId === 202) return Promise.resolve({ object: { objectId: 'input-object' } });
          if (params.backendNodeId === 201) return Promise.resolve({ object: { objectId: 'button-object' } });
          if (params.backendNodeId === 333) return Promise.resolve({ object: { objectId: 'frame-owner' } });
          return Promise.resolve({ object: { objectId: 'other' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          if (params.objectId === 'input-object') {
            return Promise.resolve({ result: { value: { x: 8, y: 80, w: 185, h: 21, position: '' } } });
          }
          if (params.objectId === 'button-object') {
            return Promise.resolve({ result: { value: { x: 8, y: 8, w: 80, h: 24, position: '' } } });
          }
          if (params.objectId === 'frame-owner') {
            return Promise.resolve({ result: { value: { x: 218, y: 275, w: 400, h: 200 } } });
          }
          return Promise.resolve({ result: { value: { x: 0, y: 0, w: 0, h: 0, position: '' } } });
        }
        if (method === 'DOM.getFrameOwner') {
          return Promise.resolve({ backendNodeId: 333 });
        }
        if (method === 'DOM.describeNode') {
          return Promise.resolve({ node: {} });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };

    const out = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { frameRef: '@f2', cursorInteractive: true },
      refState,
    );
    expect(out).toContain('Interactive: 1 button, 1 input[text]');
    expect(out).toContain('[button] outer-btn  @f2:1  (226,283 80×24)');
    expect(out).toMatch(/\[textbox\].*@f2:2\s+\(226,355 185×21\)/);
    expect(out).toContain('input#oin');
    expect(out).toContain('@f2:2');
    expect(out).toContain('(226,355 185×21)');
    expect(out).not.toMatch(/input#oin[^\n]*\(8,80/);
    expect(refState.frameRefs.get('@f2').refs.get(2)).toBe(202);
  });

  it('#261 never synthesizes hidden inputs as [textbox] @refs', () => {
    expect(T.isSynthesizableDomControl({ tag: 'input', type: 'hidden', role: 'textbox', backendNodeId: 9 })).toBe(false);
    expect(T.isSynthesizableDomControl({ tag: 'input', type: 'text', hidden: true, backendNodeId: 9 })).toBe(false);
    expect(T.isSynthesizableDomControl({ tag: 'input', type: 'text', display: 'none', backendNodeId: 9 })).toBe(false);
    expect(T.shouldSynthesizeMissingFrameInteractives(null, [], [
      { tag: 'input', type: 'text', role: 'textbox' },
    ])).toBe(false);

    const axNodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example' }, childIds: [] },
    ];
    const merged = T.mergeMissingDomInteractiveAxNodes(axNodes, [
      { backendNodeId: 9, tag: 'input', type: 'hidden', role: 'textbox', id: 'csrf', name: '' },
      { backendNodeId: 10, tag: 'input', type: 'text', hidden: true, role: 'textbox', id: 'ghost' },
    ]);
    const refMap = new Map();
    const { treeLines } = T.buildPerceiveTree(merged, { layoutMap: {}, styleHints: {} }, refMap);
    expect(refMap.size).toBe(0);
    expect(treeLines.join('\n')).not.toMatch(/\[textbox\]/);
  });

  it('#261 -C attaches @fN:M by selector/id, not 1px-exact rect equality', () => {
    const control = T.attachRefToVisibleControl(
      { tag: 'input', role: 'textbox', label: 'oin', rect: { x: 227, y: 354, w: 185, h: 21 }, selector: 'input#oin', hints: { id: 'oin' } },
      T.refAnnotationsFromTreeLines(['[textbox] oin  @f2:2  (226,355 185×21)']),
    );
    expect(control.ref).toBe('@f2:2');
  });

  it('#261 top-level perceive does not describeNode or synthesize hidden inputs when counts exceed AX', async () => {
    const methods = [];
    const cdp = {
      send(method, params = {}) {
        methods.push({ method, params });
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({
            result: {
              value: pageSnapshotValue({
                counts: { button: 1, 'input[text]': 1, 'input[hidden]': 1, div: 3 },
                visibleControls: [],
              }),
            },
          });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({
            nodes: [
              { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example' }, childIds: ['2'] },
              { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 11 },
            ],
          });
        }
        if (method === 'DOM.describeNode') {
          throw new Error('top-level perceive must not describeNode for AX synthesis');
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
    const out = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      { output: null, snapshotOpts: null },
      { cursorInteractive: true },
      {},
    );
    expect(methods.some(item => item.method === 'DOM.describeNode')).toBe(false);
    expect(methods.some(item => String(item.params?.expression || '').includes('chromeCdpDomInteractiveList'))).toBe(false);
    expect(out).not.toMatch(/\[textbox\].*csrf|input\[type=hidden\]/i);
    expect(out).not.toMatch(/@2\b/);
  });

  it('#261 fill and resolveRefNode accept a synthesized @f2:2 when AX omits the framed input', async () => {
    const cdp = framedUnnamedInputCdp({ axOmitsInput: true, filledText: 'hello-oin' });
    const store = { output: null, snapshotOpts: null };
    const refState = {};
    const out = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { frameRef: '@f2', cursorInteractive: true },
      refState,
    );
    expect(cdp.methods.some(item => item.method === 'DOM.describeNode')).toBe(true);
    expect(out).toMatch(/\[textbox\].*@f2:2/);
    expect(refState.frameRefs.get('@f2').refs.get(2)).toBe(202);

    const objectId = await T.resolveRefNode(cdp, 'sid', new Map(), '@f2:2', refState);
    expect(objectId).toBe('input-object');
    const filled = await T.fillStr(cdp, 'sid', '@f2:2', 'hello-oin', new Map(), refState);
    expect(filled).toContain('@f2:2');
    expect(filled).toContain('hello-oin');
  });

  it('#261 nested srcdoc @f3 fill works when AX omits the unnamed input', async () => {
    const cdp = framedUnnamedInputCdp({
      frameId: 'inner-frame',
      axOmitsInput: true,
      nested: true,
      filledText: 'nested-oin',
    });
    const refState = {};
    const out = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      { output: null, snapshotOpts: null },
      { frameRef: '@f3', cursorInteractive: true },
      refState,
    );
    expect(out).toContain('Frame: @f3');
    expect(out).toMatch(/\[textbox\].*@f3:2/);
    expect(refState.frameRefs.get('@f3').refs.get(2)).toBe(202);
    const filled = await T.fillStr(cdp, 'sid', '@f3:2', 'nested-oin', new Map(), refState);
    expect(filled).toContain('@f3:2');
    expect(filled).toContain('nested-oin');
  });
});

describe('issue #262 checkbox/radio/select-multiple settle honesty', () => {
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  it('#262 unnamed checkbox/radio appear in the AX dump with @refs', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'WebArea' }, name: { value: 'Example' }, childIds: ['2', '3', '4'] },
      {
        nodeId: '2', parentId: '1', role: { value: 'checkbox' }, name: { value: '' },
        backendDOMNodeId: 11, checked: { value: false },
      },
      {
        nodeId: '3', parentId: '1', role: { value: 'radio' }, name: { value: '' },
        backendDOMNodeId: 12, checked: { value: false },
      },
      {
        nodeId: '4', parentId: '1', role: { value: 'radio' }, name: { value: '' },
        backendDOMNodeId: 13, checked: { value: true },
      },
    ];
    const { treeLines } = T.buildPerceiveTree(nodes, { layoutMap: {}, styleHints: {} }, new Map());
    const output = treeLines.join('\n');
    expect(output).toMatch(/\[checkbox\] checked=false\s+@1/);
    expect(output).toMatch(/\[radio\] checked=false\s+@2/);
    expect(output).toMatch(/\[radio\] checked=true\s+@3/);
  });

  it('#262 a dispatched click that flips .checked is Outcome:changed / continue, not overlay', () => {
    const result = T.createActionResult({
      action: 'click',
      target: {
        targetId: 'ABC123',
        input: '#p16cb',
        resolvedBy: 'selector',
        label: '#p16cb',
        controlStateChanged: true,
        controlStateDiff: 'checkbox #p16cb checked false → true',
      },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: {
        domDiff: '(no changes detected in AX tree)',
        console: [],
        network: [],
        navigation: null,
        ...emptyDelta,
        consoleDelta: emptyDelta.console,
        exceptionDelta: emptyDelta.exceptions,
        networkDelta: emptyDelta.network,
      },
    });
    expect(result.outcome).toMatchObject({ status: 'changed', changed: true });
    expect(result.verdict).toMatchObject({ status: 'continue', canContinue: true });
    expect(T.formatActionText(result)).not.toMatch(/overlay "#p16cb"/);
  });

  it('#262 select multiple selectedOptions change is Outcome:changed', () => {
    expect(T.formControlStateChanged(
      { tag: 'select', multiple: true, selected: ['a'] },
      { tag: 'select', multiple: true, selected: ['b'] },
    )).toBe(true);
    expect(T.formatFormControlStateDiff(
      { tag: 'select', id: 'p16msel', selected: ['a'] },
      { tag: 'select', id: 'p16msel', selected: ['b'] },
    )).toContain('["b"]');

    const result = T.createActionResult({
      action: 'select',
      target: {
        targetId: 'ABC123',
        input: '#p16msel',
        resolvedBy: 'selector',
        label: '#p16msel',
        controlStateChanged: true,
        controlStateDiff: 'select #p16msel selected ["a"] → ["b"]',
      },
      dispatch: { ok: true, method: 'select' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
    });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
  });

  it('#262 no-op Escape / dismiss-modal with no dialog stay no-change + continue', () => {
    const press = T.createActionResult({
      action: 'press',
      target: { targetId: 'ABC123', input: 'Escape', resolvedBy: 'key', label: 'Escape', expectedOutcome: 'press-no-change' },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 20 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
    });
    expect(press.outcome.status).toBe('no-change');
    expect(press.verdict.status).toBe('continue');
    expect(press.verdict.canContinue).toBe(true);

    const dismiss = T.createActionResult({
      action: 'dismiss-modal',
      target: { targetId: 'ABC123', input: 'modal', resolvedBy: 'dialog', label: 'modal', expectedOutcome: 'no-modal' },
      dispatch: { ok: true, method: 'dismiss-modal' },
      settle: { ok: true, durationMs: 20 },
      effects: { domDiff: 'No changes detected (no modal).', console: [], network: [], navigation: null },
    });
    expect(dismiss.outcome.status).toBe('no-change');
    expect(dismiss.verdict.status).toBe('continue');
  });

  async function snapshotThenOutcome({ action, input, before, after }) {
    expect(T.shouldSnapshotFormControlState(action, { input, resolvedBy: 'selector' })).toBe(true);
    const values = [before, after];
    const cdp = {
      send(method) {
        if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') {
          const snapshot = values.shift();
          return Promise.resolve({ result: { value: snapshot } });
        }
        return Promise.resolve({});
      },
    };
    const beforeSnap = await T.snapshotFormControlState(cdp, 'sid', input, new Map(), {});
    const afterSnap = await T.snapshotFormControlState(cdp, 'sid', input, new Map(), {});
    expect(beforeSnap).toEqual(before);
    expect(afterSnap).toEqual(after);
    expect(T.formControlStateChanged(beforeSnap, afterSnap)).toBe(true);
    const result = T.createActionResult({
      action,
      target: {
        targetId: 'ABC123',
        input,
        resolvedBy: 'selector',
        label: input,
        controlStateChanged: T.formControlStateChanged(beforeSnap, afterSnap),
        controlStateDiff: T.formatFormControlStateDiff(beforeSnap, afterSnap),
      },
      dispatch: { ok: true, method: action },
      settle: { ok: true, durationMs: 40 },
      effects: {
        domDiff: '(no changes detected in AX tree)',
        console: [],
        network: [],
        navigation: null,
        ...emptyDelta,
        consoleDelta: emptyDelta.console,
        exceptionDelta: emptyDelta.exceptions,
        networkDelta: emptyDelta.network,
      },
    });
    expect(result.outcome).toMatchObject({ status: 'changed', changed: true });
    expect(result.verdict).toMatchObject({ status: 'continue', canContinue: true });
    expect(T.formatActionText(result)).not.toMatch(new RegExp(`overlay "${input.replace('#', '\\#')}"`));
    return result;
  }

  it('#262 snapshotFormControlState probe path flips checkbox .checked to Outcome:changed', async () => {
    await snapshotThenOutcome({
      action: 'click',
      input: '#p16cb',
      before: { tag: 'input', type: 'checkbox', id: 'p16cb', checked: false },
      after: { tag: 'input', type: 'checkbox', id: 'p16cb', checked: true },
    });
  });

  it('#262 snapshotFormControlState probe path flips radio .checked to Outcome:changed', async () => {
    await snapshotThenOutcome({
      action: 'click',
      input: '#p16radio',
      before: { tag: 'input', type: 'radio', id: 'p16radio', checked: false },
      after: { tag: 'input', type: 'radio', id: 'p16radio', checked: true },
    });
  });

  it('#262 snapshotFormControlState probe path for select-multiple is Outcome:changed', async () => {
    const result = await snapshotThenOutcome({
      action: 'select',
      input: '#p16msel',
      before: { tag: 'select', type: 'select-multiple', id: 'p16msel', multiple: true, selected: ['a'], value: 'a' },
      after: { tag: 'select', type: 'select-multiple', id: 'p16msel', multiple: true, selected: ['b'], value: 'b' },
    });
    expect(result.target.controlStateDiff).toContain('["b"]');
  });
});

describe('issue #263 prompt() JavaScript dialog handling', () => {
  it('#263 dismiss still sends promptText so Chrome can close prompt()', () => {
    expect(T.javascriptDialogHandleParams({ type: 'prompt', defaultPrompt: 'def' }, false)).toEqual({
      accept: false,
      promptText: 'def',
    });
    expect(T.javascriptDialogHandleParams({ type: 'prompt' }, true)).toEqual({
      accept: true,
      promptText: '',
    });
    expect(T.javascriptDialogHandleParams({ type: 'confirm', message: 'p16-confirm' }, true)).toEqual({
      accept: true,
      promptText: '',
    });
  });

  it('#263 retries handleJavaScriptDialog until the prompt is visible to CDP', async () => {
    const calls = [];
    const cdp = {
      send(method, params = {}, sessionId) {
        calls.push({ method, params, sessionId });
        if (method === 'Page.handleJavaScriptDialog' && calls.filter(c => c.method === method).length < 3) {
          return Promise.reject(new Error('No dialog is showing'));
        }
        return Promise.resolve({});
      },
    };
    const buf = new T.RingBuffer(8);
    const result = await T.handleOpeningJavaScriptDialog(
      cdp,
      'sid-page',
      { type: 'prompt', message: 'p16-prompt', defaultPrompt: 'def' },
      { sessionId: 'sid-page' },
      { accept: false, dialogBuf: buf, retries: 6, delayMs: 1 },
    );
    expect(result.ok).toBe(true);
    expect(calls.some(c => c.method === 'Page.handleJavaScriptDialog' && c.params.accept === false && c.params.promptText === 'def')).toBe(true);
    expect(buf.all()[0]).toMatchObject({ type: 'prompt', message: 'p16-prompt', defaultPrompt: 'def' });
  });

  it('#263 tracks in-flight dialog handles so click can wait instead of orphaning the daemon', async () => {
    const session = T.createJavaScriptDialogSession();
    let released = false;
    const pending = new Promise(resolve => setTimeout(() => {
      released = true;
      resolve({ ok: true });
    }, 20));
    session.track(pending);
    expect(session.pending.size).toBe(1);
    await session.waitForPending(500);
    expect(released).toBe(true);
    expect(session.pending.size).toBe(0);
  });

  it('#263 failed handleJavaScriptDialog does not Runtime.evaluate', async () => {
    const session = T.createJavaScriptDialogSession();
    session.track(Promise.resolve({ ok: false, error: new Error('No dialog is showing') }));
    await session.waitForPending(100);
    expect(session.hasFailedHandle()).toBe(true);
    expect(T.shouldSkipActionPageEvaluate(session)).toBe(true);
    let evaluated = false;
    const text = await T.observeAfterActionGuardingDialogs(session, async () => {
      evaluated = true;
      return 'AX snapshot';
    });
    expect(evaluated).toBe(false);
    expect(text).toMatch(/JavaScript dialog still open/i);
    expect(text).toMatch(/skipped page evaluate/i);
  });

  it('#263 click still returns an observe receipt when javascriptDialogOpening never fires', async () => {
    const session = T.createJavaScriptDialogSession();
    const started = Date.now();
    let evaluated = false;
    const text = await T.observeAfterActionGuardingDialogs(session, async () => {
      evaluated = true;
      return '(no changes detected in AX tree)';
    });
    expect(Date.now() - started).toBeLessThan(200);
    expect(session.hasPending()).toBe(false);
    expect(session.hasFailedHandle()).toBe(false);
    expect(evaluated).toBe(true);
    expect(text).toContain('no changes detected');
  });

  it('#263 retries handleJavaScriptDialog only on the event/page session, never the browser session', async () => {
    const calls = [];
    const cdp = {
      send(method, params = {}, sessionId) {
        calls.push({ method, params, sessionId });
        return Promise.reject(new Error('No dialog is showing'));
      },
    };
    const result = await T.handleOpeningJavaScriptDialog(
      cdp,
      'sid-page',
      { type: 'prompt', message: 'p16-prompt', defaultPrompt: 'def' },
      { sessionId: 'sid-event' },
      { accept: false, retries: 2, delayMs: 1 },
    );
    expect(result.ok).toBe(false);
    const dialogCalls = calls.filter(item => item.method === 'Page.handleJavaScriptDialog');
    expect(dialogCalls.length).toBeGreaterThan(0);
    expect(dialogCalls.every(item => item.sessionId === 'sid-event' || item.sessionId === 'sid-page')).toBe(true);
    expect(dialogCalls.some(item => item.sessionId == null)).toBe(false);
    expect(dialogCalls.every(item => item.params.promptText === 'def')).toBe(true);
  });
});

describe('issue #266 click mouse events must land or fail closed', () => {
  const layoutNoise = '+++ Added (1):\n+   [generic] layout-noise';
  const TARGET_ID = '62E1DF19';

  function createPicky17Page({ deliverMouseEvents = true } = {}) {
    const state = {
      clicks: 0,
      checked: false,
      probeSeen: [],
      mouseTypes: [],
      movedAcked: false,
      pressedWhileMovePending: false,
      probeInstalledOn: null,
    };
    const cdp = {
      calls: [],
      send(method, params = {}, sessionId, timeout) {
        cdp.calls.push({ method, params, sessionId, timeout });
        const probeSource = method === 'Runtime.evaluate'
          ? String(params.expression || '')
          : method === 'Runtime.callFunctionOn'
            ? String(params.functionDeclaration || '')
            : '';
        if (probeSource.includes('__chromeCdpExClickProbe')) {
          const framedNode = method === 'Runtime.callFunctionOn' && params.objectId === 'child-button';
          if (probeSource.includes('installed: true')) {
            state.probeSeen = [];
            state.probeInstalledOn = framedNode ? 'iframe' : 'top';
            return Promise.resolve({
              result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: framedNode ? 'target-document' : 'top' } },
            });
          }
          return Promise.resolve({
            result: { value: { cdpClickProbe: true, ok: true, seen: state.probeSeen.slice() } },
          });
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes("type === 'checkbox'") || expr.includes('el.checked === true')) {
            return Promise.resolve({
              result: { value: { tag: 'input', type: 'checkbox', id: 'p17cb', checked: state.checked } },
            });
          }
          if (expr === 'location.href' || expr.includes('document.title')) {
            return Promise.resolve({ result: { value: 'https://example.com/' } });
          }
          return Promise.resolve({
            result: {
              value: {
                ok: true,
                x: 51,
                y: 110,
                w: 80,
                h: 24,
                tag: 'BUTTON',
                text: 'p17-click',
              },
            },
          });
        }
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('this.click()')) {
            state.clicks += 1;
            state.checked = true;
            return Promise.resolve({ result: { value: { tag: 'INPUT', text: 'p17cb' } } });
          }
          if (fn.includes('el.checked === true') || fn.includes("type === 'checkbox'")) {
            return Promise.resolve({
              result: { value: { tag: 'input', type: 'checkbox', id: 'p17cb', checked: state.checked } },
            });
          }
          return Promise.resolve({
            result: {
              value: {
                connected: true,
                x: 51,
                y: 110,
                w: 80,
                h: 24,
                tag: 'BUTTON',
                text: 'p17-click',
              },
            },
          });
        }
        if (method === 'Input.dispatchMouseEvent') {
          state.mouseTypes.push(params.type);
          if (params.type === 'mousePressed' && !state.movedAcked) {
            state.pressedWhileMovePending = true;
          }
          if (params.type === 'mouseMoved') state.movedAcked = true;
          const pressOrRelease = params.type === 'mousePressed' || params.type === 'mouseReleased';
          if (pressOrRelease && Number(timeout) < T.CLICK_MOUSE_ACK_TIMEOUT_MS) {
            return Promise.reject(new Error('Timeout: Input.dispatchMouseEvent'));
          }
          if (deliverMouseEvents) {
            if (params.type === 'mousePressed') state.probeSeen.push('mousedown', 'pointerdown');
            if (params.type === 'mouseReleased') {
              state.probeSeen.push('mouseup', 'pointerup', 'click');
              state.clicks += 1;
              state.checked = true;
            }
          }
          return Promise.resolve({});
        }
        if (method === 'DOM.enable') return Promise.resolve({});
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 2 });
        if (method === 'DOM.resolveNode') {
          if (params.backendNodeId === 222) return Promise.resolve({ object: { objectId: 'child-button' } });
          if (params.backendNodeId === 333) return Promise.resolve({ object: { objectId: 'frame-owner' } });
          return Promise.resolve({ object: { objectId: 'el-p17' } });
        }
        if (method === 'DOM.getFrameOwner') {
          return Promise.resolve({ backendNodeId: 333 });
        }
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'mock-root-frame' } } });
        }
        if (method === 'Page.createIsolatedWorld') {
          return Promise.resolve({ executionContextId: 901 });
        }
        return Promise.resolve({});
      },
    };
    return { cdp, state };
  }

  function formControlActionFeedback(cdp, { observeText, refMap = new Map(), refState = {} } = {}) {
    return async (action, actionDispatch, target = {}, _policy, _observe, format = 'text') => {
      const actionTarget = { ...target, targetId: target.targetId || TARGET_ID };
      const dispatch = async () => {
        const snapshotControls = T.shouldSnapshotFormControlState(action, actionTarget);
        const beforeControl = snapshotControls
          ? await T.snapshotFormControlState(cdp, 'sid', actionTarget.input, refMap, refState)
          : null;
        const text = await actionDispatch();
        if (snapshotControls) {
          const afterControl = await T.snapshotFormControlState(cdp, 'sid', actionTarget.input, refMap, refState);
          if (T.formControlStateChanged(beforeControl, afterControl)) {
            actionTarget.controlStateChanged = true;
            actionTarget.controlStateDiff = T.formatFormControlStateDiff(beforeControl, afterControl);
          }
        }
        return text;
      };
      return T.runActionWithFeedback({
        action,
        target: actionTarget,
        dispatch,
        feedbackPolicy: 'settle-diff',
        observe: async () => observeText,
        format,
      });
    };
  }

  async function clickJsonCommand(cdp, args, extras = {}) {
    const refMap = extras.refMap || new Map();
    const refState = extras.refState || {};
    const handler = T.createClickCommandHandler({
      actionFeedback: formControlActionFeedback(cdp, { ...extras, refMap, refState }),
      click: selector => T.clickStr(cdp, 'sid', selector, refMap, refState),
      jsClick: selector => T.jsClickStr(cdp, 'sid', selector, refMap, refState),
    });
    const result = await handler({ args: [...args, '--format', 'json'] });
    return JSON.parse(result.value);
  }

  it('#266 mouse click receipt is Outcome:changed from the real form-control snapshot', async () => {
    const { cdp, state } = createPicky17Page();
    const receipt = await clickJsonCommand(cdp, ['#p17cb'], {
      observeText: '(no changes detected in AX tree)',
    });

    expect(state.clicks).toBe(1);
    expect(state.checked).toBe(true);
    expect(state.probeSeen).toContain('click');
    expect(receipt.dispatch.ok).toBe(true);
    expect(receipt.target.controlStateChanged).toBe(true);
    expect(receipt.outcome).toMatchObject({ status: 'changed', changed: true });
  });

  it('#266 mouse click with no page events fails closed through runActionWithFeedback', async () => {
    const { cdp, state } = createPicky17Page({ deliverMouseEvents: false });
    const receipt = await clickJsonCommand(cdp, ['#p17cb'], { observeText: layoutNoise });

    expect(state.clicks).toBe(0);
    expect(state.checked).toBe(false);
    expect(receipt.dispatch.ok).toBe(false);
    expect(receipt.effects.failure.kind).toBe('no-input-events');
    expect(receipt.outcome.status).not.toBe('changed');
    expect(receipt.outcome).toMatchObject({ status: 'failed', changed: false });
    expect(receipt.effects.failure.nextCommand).toBe(`cdp jsclick ${TARGET_ID} #p17cb`);
    expect(receipt.effects.diagnosis.nextCommand).toBe(`cdp jsclick ${TARGET_ID} #p17cb`);
    expect(state.mouseTypes).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);

    const jsReceipt = await clickJsonCommand(cdp, ['--js', '#p17cb'], {
      observeText: '(no changes detected in AX tree)',
    });
    expect(state.clicks).toBe(1);
    expect(state.checked).toBe(true);
    expect(state.mouseTypes).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(jsReceipt.dispatch.ok).toBe(true);
    expect(jsReceipt.target.controlStateChanged).toBe(true);
    expect(jsReceipt.outcome).toMatchObject({ status: 'changed', changed: true });
  });

  it('#266 clickxy --format json with no page events also fails closed', async () => {
    const { cdp, state } = createPicky17Page({ deliverMouseEvents: false });
    const receipt = JSON.parse(await T.runActionWithFeedback({
      action: 'clickxy',
      target: { targetId: TARGET_ID, input: '51,110', resolvedBy: 'coordinates', label: '51,110' },
      dispatch: () => T.clickXyStr(cdp, 'sid', 51, 110),
      feedbackPolicy: 'settle-diff',
      observe: async () => layoutNoise,
      format: { format: 'json' },
    }));
    expect(state.clicks).toBe(0);
    expect(receipt.dispatch.ok).toBe(false);
    expect(receipt.effects.failure.kind).toBe('no-input-events');
    expect(receipt.outcome.status).not.toBe('changed');
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed')).toBe(true);
  });

  it('#266 probe not installed + 250ms swallow fails closed', async () => {
    const events = [];
    await expect(T.dispatchClick({
      send(method, params = {}, _sessionId, timeoutMs) {
        if (method === 'Input.dispatchMouseEvent') {
          events.push({ ...params, timeoutMs });
          return Promise.reject(new Error('Timeout: Input.dispatchMouseEvent'));
        }
        return Promise.resolve({});
      },
    }, 'sid', 40, 20)).rejects.toThrow(/received no mousedown\/click events/);
    expect(events).toHaveLength(3);
    expect(events[0].timeoutMs).toBe(T.HOVER_MOUSE_ACK_TIMEOUT_MS);
    expect(events[1].timeoutMs).toBe(T.CLICK_MOUSE_ACK_TIMEOUT_MS);
    expect(events[2].timeoutMs).toBe(T.CLICK_MOUSE_ACK_TIMEOUT_MS);
  });

  it('#266 250ms compositor-ack swallow does not deliver page events and fails closed', async () => {
    const { cdp, state } = createPicky17Page();
    const originalSend = cdp.send.bind(cdp);
    cdp.send = (method, params = {}, sessionId, timeout) => {
      if (method === 'Input.dispatchMouseEvent' && (params.type === 'mousePressed' || params.type === 'mouseReleased')) {
        return originalSend(method, params, sessionId, T.HOVER_MOUSE_ACK_TIMEOUT_MS);
      }
      return originalSend(method, params, sessionId, timeout);
    };
    const receipt = await clickJsonCommand(cdp, ['#p17cb'], { observeText: layoutNoise });
    expect(receipt.dispatch.ok).toBe(false);
    expect(receipt.effects.failure.kind).toBe('no-input-events');
    expect(state.clicks).toBe(0);
    expect(state.checked).toBe(false);
    expect(state.probeSeen).toEqual([]);
  });

  it('#266 CLI Next for no-input-events includes the selector', () => {
    const message = 'click: Input.dispatchMouseEvent completed but the page received no mousedown/click events at (51, 110) for #p17cb. The mouse path failed closed. Try jsclick or click --js.';
    const cli = T.formatCliError(new Error(message), {
      cmd: 'click',
      targetPrefix: TARGET_ID,
      args: ['#p17cb'],
    });
    expect(cli).toMatch(/Kind: no-input-events/);
    expect(cli).toMatch(new RegExp(`Next: cdp jsclick ${TARGET_ID} #p17cb`));
    expect(cli).not.toMatch(new RegExp(`Next: cdp jsclick ${TARGET_ID}$`, 'm'));
  });

  it('#266 framed @f2:1 probes the iframe document and succeeds when the iframe handler ran', async () => {
    const { cdp, state } = createPicky17Page();
    const refState = {
      frameRefs: new Map([
        ['@f2', {
          frameRef: '@f2',
          frameId: 'checkout-frame',
          parentId: 'main-frame',
          refs: new Map([[1, 222]]),
        }],
      ]),
    };
    const originalSend = cdp.send.bind(cdp);
    cdp.send = (method, params = {}, sessionId, timeout) => {
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'frame-owner') {
        cdp.calls.push({ method, params, sessionId, timeout });
        return Promise.resolve({ result: { value: { x: 50, y: 40, w: 300, h: 200 } } });
      }
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'child-button') {
        cdp.calls.push({ method, params, sessionId, timeout });
        const fn = String(params.functionDeclaration || '');
        if (fn.includes('__chromeCdpExClickProbe') && fn.includes('installed: true')) {
          state.probeSeen = [];
          state.probeInstalledOn = 'iframe';
          return Promise.resolve({
            result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: 'target-document' } },
          });
        }
        if (fn.includes('__chromeCdpExClickProbe')) {
          return Promise.resolve({
            result: { value: { cdpClickProbe: true, ok: true, seen: state.probeSeen.slice() } },
          });
        }
        if (fn.includes('requestAnimationFrame') || fn.includes('getBoundingClientRect')) {
          return Promise.resolve({
            result: { value: { connected: true, x: 10, y: 5, w: 100, h: 20, tag: 'BUTTON', text: 'Pay now' } },
          });
        }
      }
      return originalSend(method, params, sessionId, timeout);
    };

    const receipt = await clickJsonCommand(cdp, ['@f2:1'], {
      observeText: '(no changes detected in AX tree)',
      refState,
    });
    expect(state.probeInstalledOn).toBe('iframe');
    expect(state.clicks).toBe(1);
    expect(receipt.dispatch.ok).toBe(true);
    expect(receipt.outcome.status).not.toBe('failed');
    expect(cdp.calls.some(call => (
      call.method === 'Runtime.callFunctionOn'
      && call.params.objectId === 'child-button'
      && String(call.params.functionDeclaration || '').includes('__chromeCdpExClickProbe')
    ))).toBe(true);
  });

  it('#266 framed @f2:1 does not fail-close from a top-level empty seen', async () => {
    const { cdp, state } = createPicky17Page();
    const refState = {
      frameRefs: new Map([
        ['@f2', {
          frameRef: '@f2',
          frameId: 'checkout-frame',
          parentId: 'main-frame',
          refs: new Map([[1, 222]]),
        }],
      ]),
    };
    const originalSend = cdp.send.bind(cdp);
    cdp.send = (method, params = {}, sessionId, timeout) => {
      if (method === 'DOM.resolveNode' && params.backendNodeId === 222 && params.executionContextId == null) {
        cdp.calls.push({ method, params, sessionId, timeout });
        return Promise.reject(new Error('page-world object unavailable'));
      }
      const expr = method === 'Runtime.evaluate' ? String(params.expression || '') : '';
      if (expr.includes('__chromeCdpExClickProbe')) {
        cdp.calls.push({ method, params, sessionId, timeout });
        if (expr.includes('installed: true')) {
          state.probeSeen = [];
          state.probeInstalledOn = 'top';
          return Promise.resolve({
            result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: 'top' } },
          });
        }
        return Promise.resolve({
          result: { value: { cdpClickProbe: true, ok: true, seen: [] } },
        });
      }
      return originalSend(method, params, sessionId, timeout);
    };

    const receipt = await clickJsonCommand(cdp, ['@f2:1'], {
      observeText: '(no changes detected in AX tree)',
      refState,
    });
    expect(state.probeInstalledOn).toBe('top');
    expect(state.clicks).toBe(1);
    expect(receipt.dispatch.ok).toBe(true);
    expect(receipt.outcome.status).not.toBe('failed');
  });

  it('#266 sends mousePressed before mouseMoved compositor ack resolves', async () => {
    const { cdp, state } = createPicky17Page();
    let movedResolve;
    const originalSend = cdp.send.bind(cdp);
    cdp.send = (method, params = {}, sessionId, timeout) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        state.mouseTypes.push('mouseMoved');
        cdp.calls.push({ method, params, sessionId, timeout });
        return new Promise(resolve => {
          movedResolve = () => {
            state.movedAcked = true;
            resolve({});
          };
        });
      }
      return originalSend(method, params, sessionId, timeout);
    };

    const pending = T.dispatchClick(cdp, 'sid', 51, 110);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(state.mouseTypes.slice(0, 2)).toEqual(['mouseMoved', 'mousePressed']);
    expect(state.pressedWhileMovePending).toBe(true);
    expect(state.movedAcked).toBe(false);
    movedResolve();
    await pending;
    expect(state.clicks).toBe(1);
  });
});

describe('issue #267 restore --unsafe-full cookie fidelity', () => {
  it('#267 unsafe-full restore writes the original cookie, not the literal <redacted> sentinel', async () => {
    const setCookies = [];
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        if (method === 'Network.setCookie') {
          setCookies.push(params);
          return Promise.resolve({ success: true });
        }
        if (method === 'Page.navigate') return Promise.resolve({ loaderId: 'loader-1' });
        if (method === 'Runtime.evaluate') {
          if (params.expression === 'location.href') {
            return Promise.resolve({ result: { value: 'https://example.com/#p17mut2' } });
          }
          return Promise.resolve({ result: { value: 'restored' } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.resolve({}), cancel() {} };
      },
    };
    const checkpoint = {
      schema: 'chrome-cdp-ex.checkpoint.v1',
      privacy: { redaction: 'unsafe-full', cookies: false, storage: false },
      page: { url: 'https://example.com/', title: 'Example', origin: 'https://example.com' },
      storage: { localStorage: {}, sessionStorage: {} },
      cookies: [{ name: 'picky17full', value: 'orig', domain: 'example.com', path: '/' }],
    };

    const out = await T.restoreCheckpointStr(cdp, 'sid', ['--json', JSON.stringify(checkpoint)]);

    expect(out).toContain('Restored checkpoint');
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toMatchObject({ name: 'picky17full', value: 'orig' });
    expect(setCookies[0].value).not.toBe('<redacted>');
    expect(T.sanitizeCheckpointCookies(checkpoint.cookies)[0].value).toBe('<redacted>');
    expect(T.cookiesForRestore(checkpoint.cookies)[0].value).toBe('orig');
  });

  it('#267 default redacted checkpoint restore leaves later cookies in place', async () => {
    const setCookies = [];
    const cdp = {
      send(method, params = {}) {
        if (method === 'Network.setCookie') {
          setCookies.push(params);
          return Promise.resolve({ success: true });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: 'https://example.com/' } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.resolve({}), cancel() {} };
      },
    };
    const checkpoint = {
      schema: 'chrome-cdp-ex.checkpoint.v1',
      page: { url: 'https://example.com/', title: 'Example', origin: 'https://example.com' },
      storage: { localStorage: {}, sessionStorage: {} },
      cookies: [{
        name: 'picky17full',
        value: '<redacted>',
        domain: 'example.com',
        path: '/',
        redacted: ['value'],
      }],
    };

    const out = await T.restoreCheckpointStr(cdp, 'sid', ['--json', JSON.stringify(checkpoint)]);
    expect(out).toContain('cookies: 0');
    expect(setCookies).toEqual([]);
    expect(T.cookiesForRestore(checkpoint.cookies)).toEqual([]);
  });
});

describe('issue #270 record-actions password dispatchText redaction', () => {
  it('#270 record-actions JSON redacts dispatchText and sibling fields for a password-like fill', () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'cdp-p18w-pass-')), 'session.jsonl');
    const secret = 'dummy-secret-p18';
    const state = T.createSessionState({ targetId: 'P18WPASS', sessionId: 'sid-p18', logPath });

    T.appendSessionActionLog(state, T.createActionResult({
      action: 'fill',
      target: {
        input: '#p18w-pass',
        resolvedBy: 'selector',
        label: '#p18w-pass',
        commandArgs: ['#p18w-pass', secret],
        dispatchText: `Filled <INPUT> with "${secret}"`,
        controlStateDiff: `value "" → "${secret}"`,
      },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: true, durationMs: 42 },
      effects: {
        domDiff: `Control state changed: value "" → "${secret}"`,
        console: [],
        network: [],
        navigation: null,
      },
      nextHint: null,
    }));

    const json = T.formatRecordActions(state, { format: 'json' });
    const model = JSON.parse(json);
    const step = model.actions[0];
    const serialized = JSON.stringify(model);

    expect(serialized).not.toContain(secret);
    expect(step.command).toEqual(['fill', '#p18w-pass', '<redacted>']);
    expect(step.target.commandArgs).toEqual(['#p18w-pass', '<redacted>']);
    expect(step.target.redacted).toEqual(expect.arrayContaining(['commandArgs']));
    expect(step.replayable).toBe(false);
    expect(step.needsInput).toEqual(['text']);
    expect(String(step.target.dispatchText || '')).not.toContain(secret);
    expect(String(step.target.dispatchText || '')).toMatch(/<redacted>/);
    expect(JSON.stringify(step.target)).not.toContain(secret);
    expect(JSON.stringify(step.evidence || {})).not.toContain(secret);
    expect(readFileSync(logPath, 'utf8')).not.toContain(secret);
    expect(T.formatExportPlaywright(state)).not.toContain(secret);
  });
});

describe('issue #271 cascade injected !important beats inline', () => {
  it('#271 winner and editTarget match computedValue when injected !important beats inline', async () => {
    const cdp = {
      send(method) {
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 10 });
        if (method === 'CSS.getMatchedStylesForNode') {
          return Promise.resolve({
            matchedCSSRules: [{
              rule: {
                selectorList: { text: '#p18w-label' },
                origin: 'injected',
                style: {
                  styleSheetId: 'inject-1',
                  range: { startLine: 0 },
                  cssProperties: [{
                    name: 'background-color',
                    value: '#00ffff',
                    important: true,
                  }],
                },
              },
            }],
            inlineStyle: {
              cssProperties: [{ name: 'background-color', value: 'rgb(255, 255, 0)' }],
            },
            inherited: [],
          });
        }
        if (method === 'CSS.getComputedStyleForNode') {
          return Promise.resolve({
            computedStyle: [{ name: 'background-color', value: 'rgb(0, 255, 255)' }],
          });
        }
        if (method === 'CSS.getStyleSheetText') {
          return Promise.resolve({ text: '#p18w-label{background:#00ffff !important}' });
        }
        return Promise.resolve({});
      },
    };

    const model = JSON.parse(await T.cascadeStr(
      cdp, 'sid', '#p18w-label', 'background-color', new Map(), null, { format: 'json' },
    ));
    const property = model.properties[0];
    expect(property.computedValue).toBe('rgb(0, 255, 255)');
    expect(property.winner).toMatchObject({
      selector: '#p18w-label',
      value: '#00ffff',
      origin: 'injected',
    });
    expect(property.winner.selector).not.toBe('[inline]');
    expect(property.winner.value).not.toBe('rgb(255, 255, 0)');
    expect(model.editTarget).toMatchObject({
      property: 'background-color',
      selector: '#p18w-label',
      value: '#00ffff',
      origin: 'injected',
    });
    const injected = property.rules.find(rule => rule.origin === 'injected');
    const inline = property.rules.find(rule => rule.selector === '[inline]');
    expect(injected).toMatchObject({ winner: true, overridden: false, value: '#00ffff' });
    expect(inline).toMatchObject({ winner: false, overridden: true, value: 'rgb(255, 255, 0)' });
    expect(property.rules.filter(rule => rule.winner)).toHaveLength(1);
  });
});

describe('issue #272 replay incomplete fill must not guess empty text', () => {
  function replayArtifact(actions) {
    return {
      schema: 'chrome-cdp-ex.record-actions.v1',
      targetId: 'P18WTEXT',
      sessionId: 'sid-p18',
      source: 'test',
      actionCount: actions.length,
      actions,
    };
  }

  it('#272 replay of fill with needsInput text and no value does not apply empty string', async () => {
    const calls = [];
    const source = replayArtifact([{
      index: 1,
      action: 'fill',
      command: ['fill', '#p18w-text'],
      replayable: true,
      needsInput: ['text'],
    }]);

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step);
        return { ok: true, result: 'Filled <INPUT> with ""' };
      },
    }, ['--format', 'json', '--json', JSON.stringify(source)]);
    const parsed = JSON.parse(out);

    expect(calls).toEqual([]);
    expect(parsed.counts.ok).toBe(0);
    expect(parsed.counts.ok).not.toBeGreaterThan(0);
    expect(parsed.steps[0].ok).not.toBe(true);
    expect(parsed.steps[0].missing).toEqual(expect.arrayContaining(['text']));
    expect(JSON.stringify(parsed)).not.toMatch(/Filled <INPUT> with ""/);
    expect(parsed.counts.skipped + parsed.counts.failed).toBeGreaterThan(0);
  });

  it('#272 password fill remains skipped as missing text without guessing empty string', async () => {
    const calls = [];
    const source = replayArtifact([{
      index: 1,
      action: 'fill',
      command: ['fill', '#p18w-pass', '<redacted>'],
      replayable: false,
      needsInput: ['text'],
    }]);

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step);
        return { ok: true, result: 'Filled <INPUT> with ""' };
      },
    }, ['--format', 'json', '--json', JSON.stringify(source)]);
    const parsed = JSON.parse(out);

    expect(calls).toEqual([]);
    expect(parsed.counts.ok).toBe(0);
    expect(parsed.steps[0]).toMatchObject({
      skipped: true,
      missing: ['text'],
    });
  });
});

describe('issue #274 port-bound alias eval vs fake Allow', () => {
  const LIVE_TARGET_ID = '62E1DF19ABCDEF9999DEADBEEFCAFEBABE';
  const LIVE_PAGES = [{
    targetId: LIVE_TARGET_ID,
    title: 'Example Domain',
    url: 'https://example.com/',
    type: 'page',
  }];

  function evalLikeTargetId({ requested, alias, livePages }) {
    const pages = T.selectLivePagesForAliasResolution({ alias, discoveredPages: livePages });
    return T.resolveLiveTargetBinding({ requested, livePages: pages, alias }).resolvedTargetId;
  }

  it('#274 no-port use, attach --port, and use <port>/<prefix> save the same live full target id as the prefix', async () => {
    const prefixId = T.resolveLiveTargetBinding({
      requested: '62E1DF19',
      livePages: LIVE_PAGES,
    }).resolvedTargetId;
    expect(prefixId).toBe(LIVE_TARGET_ID);
    expect(prefixId.length).toBeGreaterThan(8);

    const noPort = T.parseAliasCommandArgs(['62E1DF19', '--name', 'p19tmp'], 'use');
    const attach = T.parseAliasCommandArgs([
      '--port', '9224', '--target', '62E1DF19', '--name', 'p19att',
    ], 'attach');
    const slash = T.parseAliasCommandArgs(['9224/62E1DF19', '--name', 'p19port'], 'use');
    expect(attach.targetId).toBe('62E1DF19');
    expect(slash).toMatchObject({ port: 9224, targetId: '62E1DF19', name: 'p19port' });

    const writeStore = vi.fn(store => store);
    const discoverPages = vi.fn(async () => LIVE_PAGES);
    const noPortStore = await T.bindAndSaveTargetAlias(noPort, {
      store: T.emptyAliasStore(),
      discoverPages,
      writeStore,
    });
    const attachStore = await T.bindAndSaveTargetAlias(attach, {
      store: T.emptyAliasStore(),
      discoverPages,
      writeStore,
    });
    const slashStore = await T.bindAndSaveTargetAlias(slash, {
      store: T.emptyAliasStore(),
      discoverPages,
      writeStore,
    });

    expect(noPortStore.aliases.p19tmp.targetId).toBe(LIVE_TARGET_ID);
    expect(attachStore.aliases.p19att.targetId).toBe(LIVE_TARGET_ID);
    expect(slashStore.aliases.p19port.targetId).toBe(LIVE_TARGET_ID);
    expect(attachStore.aliases.p19att.targetId).not.toBe('62E1DF19');
    expect(slashStore.aliases.p19port.targetId).not.toBe('62E1DF19');
    expect(attachStore.aliases.p19att.targetId).toBe(prefixId);
    expect(slashStore.aliases.p19port.targetId).toBe(noPortStore.aliases.p19tmp.targetId);

    const noPortAlias = noPortStore.aliases.p19tmp;
    const attachAlias = attachStore.aliases.p19att;
    const slashAlias = slashStore.aliases.p19port;
    expect(evalLikeTargetId({ requested: 'p19tmp', alias: noPortAlias, livePages: LIVE_PAGES }))
      .toBe(LIVE_TARGET_ID);
    expect(evalLikeTargetId({ requested: 'p19att', alias: attachAlias, livePages: LIVE_PAGES }))
      .toBe(LIVE_TARGET_ID);
    expect(evalLikeTargetId({ requested: 'p19port', alias: slashAlias, livePages: LIVE_PAGES }))
      .toBe(LIVE_TARGET_ID);
    expect(evalLikeTargetId({ requested: '62E1DF19', livePages: LIVE_PAGES }))
      .toBe(LIVE_TARGET_ID);
  });

  it('#274 port-bound attach/use does not write a prefix-as-id when the live prefix is missing or ambiguous', async () => {
    const attach = T.parseAliasCommandArgs([
      '--port', '9224', '--target', '62E1DF19', '--name', 'p19att',
    ], 'attach');
    expect(() => T.bindAliasTargetFromPages(attach, [])).toThrow(/No live target matching prefix "62E1DF19".*9224/i);
    expect(() => T.bindAliasTargetFromPages(attach, [
      { targetId: '62E1DF19AAAAAAAA', title: 'A' },
      { targetId: '62E1DF19BBBBBBBB', title: 'B' },
    ])).toThrow(/ambiguous/i);

    const writeStore = vi.fn(store => store);
    await expect(T.bindAndSaveTargetAlias(attach, {
      store: T.emptyAliasStore(),
      discoverPages: async () => [],
      writeStore,
    })).rejects.toThrow(/No live target matching prefix "62E1DF19".*9224/i);
    await expect(T.bindAndSaveTargetAlias(attach, {
      store: T.emptyAliasStore(),
      discoverPages: async () => [
        { targetId: '62E1DF19AAAAAAAA', title: 'A' },
        { targetId: '62E1DF19BBBBBBBB', title: 'B' },
      ],
      writeStore,
    })).rejects.toThrow(/ambiguous/i);
    expect(writeStore).not.toHaveBeenCalled();

    const noPort = T.parseAliasCommandArgs(['62E1DF19', '--name', 'p19tmp'], 'use');
    // Characterization of the no-port path only: empty discovery keeps the requested prefix.
    expect(T.bindAliasTargetFromPages(noPort, []).targetId).toBe('62E1DF19');
  });

  it('#274 pinCdpPort discovery uses the alias CDP port and never a synthesized prefix page', async () => {
    const findSocket = vi.fn(() => '/tmp/other-port.sock');
    const connect = vi.fn(async () => ({ end() {} }));
    const request = vi.fn(async () => ({
      ok: true,
      result: JSON.stringify([{ targetId: '62E1DF19', title: 'synthesized-prefix' }]),
    }));
    const resolveWsUrl = vi.fn(async ({ env }) => {
      expect(env.CDP_PORT).toBe('9224');
      expect(env.CDP_HOST).toBe('127.0.0.1');
      return 'ws://127.0.0.1:9224/devtools/browser';
    });
    const cdp = { close: vi.fn() };
    const connectCdp = vi.fn(async (url) => {
      expect(url).toBe('ws://127.0.0.1:9224/devtools/browser');
      return cdp;
    });
    const listPages = vi.fn(async () => LIVE_PAGES);

    const pages = await T.discoverLivePagesForTargetResolution({
      env: { CDP_PORT: '9224', CDP_HOST: '127.0.0.1' },
      pinCdpPort: true,
      findSocket,
      connect,
      request,
      resolveWsUrl,
      connectCdp,
      listPages,
      rememberEndpoint: async () => null,
    });
    expect(pages).toEqual(LIVE_PAGES);
    expect(pages[0].targetId).toBe(LIVE_TARGET_ID);
    expect(pages[0].targetId).not.toBe('62E1DF19');
    expect(findSocket).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(resolveWsUrl).toHaveBeenCalledOnce();
    expect(connectCdp).toHaveBeenCalledOnce();
    expect(cdp.close).toHaveBeenCalledOnce();

    await expect(T.discoverLivePagesForTargetResolution({
      env: { CDP_PORT: '9224', CDP_HOST: '127.0.0.1' },
      pinCdpPort: true,
      findSocket,
      connect,
      request,
      resolveWsUrl: async () => {
        throw new Error('cannot reach cdp on 127.0.0.1:9224');
      },
      connectCdp,
      listPages,
    })).rejects.toThrow(/cannot reach cdp on 127\.0\.0\.1:9224/i);
    expect(findSocket).not.toHaveBeenCalled();

    const unpinned = await T.discoverLivePagesForTargetResolution({
      pinCdpPort: false,
      findSocket: () => '/tmp/daemon.sock',
      connect: async () => ({ end() {} }),
      request: async () => ({
        ok: true,
        result: JSON.stringify([{ targetId: 'DAEMONONLYFULLID' }]),
      }),
      connectCdp: async () => {
        throw new Error('unpinned discovery must not open a second CDP');
      },
    });
    expect(unpinned).toEqual([{ targetId: 'DAEMONONLYFULLID' }]);
  });

  it('#274 daemon start names the real failure when the tab is already live; never the fake Allow string', async () => {
    const allow = 'Daemon failed to start — did you click Allow in Chrome?';
    expect(T.formatDaemonStartFailure()).toBe(allow);
    const honest = T.formatDaemonStartFailure({
      liveTargetPresent: true,
      targetId: LIVE_TARGET_ID,
      lastError: new Error('still unavailable'),
    });
    expect(honest).toMatch(/62E1DF19/);
    expect(honest).toMatch(/already debuggable/i);
    expect(honest).toMatch(/still unavailable/);
    expect(honest).not.toMatch(/Allow in Chrome/);

    const recovery = T.buildCliErrorRecovery(honest, { cmd: 'eval', targetPrefix: 'p19att' });
    expect(recovery.kind).toBe('daemon-disconnect');
    expect(T.formatCliError(new Error(honest), { cmd: 'eval', targetPrefix: 'p19att' }))
      .not.toMatch(/Allow in Chrome/);

    const missingTarget = T.formatDaemonStartFailure({
      liveTargetPresent: true,
      targetId: '62E1DF19',
      lastError: new Error('attach failed: No target with given id found'),
    });
    expect(missingTarget).not.toMatch(/Allow in Chrome/);
    expect(T.buildCliErrorRecovery(missingTarget, { cmd: 'eval', targetPrefix: 'p19att' }).kind)
      .toBe('target-closed');

    const timeoutConnect = async () => { throw new Error('still unavailable'); };
    await expect(T.getOrStartTabDaemon(LIVE_TARGET_ID, {
      connect: timeoutConnect,
      unlink() {},
      spawnProcess: () => ({ unref() {} }),
      delay: async () => {},
      retries: 2,
      retryDelayMs: 1,
      platform: 'linux',
      runtimeDir: '/runtime/cdp',
      scriptPath: '/fixture/cdp.mjs',
      execPath: '/fixture/node',
      liveTargetPresent: true,
    })).rejects.toThrow(/already debuggable/i);
  });

  it('#274 CLI attach/use and later eval invoke bind+pin helpers instead of synthesizing a prefix page', async () => {
    const attach = T.parseAliasCommandArgs([
      '--port', '9224', '--target', '62E1DF19', '--name', 'p19att', '--host', '127.0.0.1',
    ], 'attach');
    const slash = T.parseAliasCommandArgs(['9224/62E1DF19', '--name', 'p19port'], 'use');
    const discoverPages = vi.fn(async (opts) => {
      expect(opts.pinCdpPort).toBe(true);
      expect(opts.env.CDP_PORT).toBe('9224');
      return LIVE_PAGES;
    });
    const writeStore = vi.fn(store => store);
    const attachStore = await T.bindAndSaveTargetAlias(attach, {
      store: T.emptyAliasStore(),
      discoverPages,
      writeStore,
      env: { HOME: '/tmp' },
    });
    const slashStore = await T.bindAndSaveTargetAlias(slash, {
      store: T.emptyAliasStore(),
      discoverPages,
      writeStore,
      env: { HOME: '/tmp' },
    });
    expect(discoverPages).toHaveBeenCalledTimes(2);
    expect(attachStore.aliases.p19att.targetId).toBe(LIVE_TARGET_ID);
    expect(slashStore.aliases.p19port.targetId).toBe(LIVE_TARGET_ID);
    expect(writeStore).toHaveBeenCalledTimes(2);

    const laterDiscover = vi.fn(async (opts) => {
      expect(opts.pinCdpPort).toBe(true);
      expect(opts.env.CDP_PORT).toBe('9224');
      expect(opts.env.CDP_HOST).toBe('127.0.0.1');
      return LIVE_PAGES;
    });
    const laterPages = await T.livePagesForTargetCommand(attachStore.aliases.p19att, {
      discoverPages: laterDiscover,
    });
    expect(laterDiscover).toHaveBeenCalledOnce();
    expect(laterPages).toEqual(LIVE_PAGES);
    expect(laterPages[0].targetId).not.toBe('62E1DF19');
    expect(T.resolveLiveTargetBinding({
      requested: 'p19att',
      livePages: laterPages,
      alias: attachStore.aliases.p19att,
    }).resolvedTargetId).toBe(LIVE_TARGET_ID);

    const src = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');
    const attachUse = src.slice(
      src.indexOf("if (cmd === 'attach' || cmd === 'use')"),
      src.indexOf("if (cmd === 'forget')"),
    );
    expect(attachUse).toMatch(/await bindAndSaveTargetAlias\(parsed/);
    expect(attachUse).not.toMatch(/function bindAndSaveTargetAlias/);
    expect(attachUse).not.toMatch(/function bindAliasTargetFromPages/);
    const targetCmd = src.slice(
      src.indexOf('Resolve against live discovery before trusting daemon or cache state'),
      src.indexOf('let rebound = false'),
    );
    expect(targetCmd).toMatch(/await livePagesForTargetCommand\(targetAlias/);
    expect(targetCmd).not.toMatch(/function livePagesForTargetCommand/);
    expect(targetCmd).not.toMatch(/targetAlias\?\.port[\s\S]{0,200}cachedPages/);
  });
});

describe('issues #276-#277 overlay detector and parallel cookies', () => {
  function runP20OverlayPage({
    targetPoint = null,
    display = 'block',
    source = null,
    includeButton = false,
  } = {}) {
    const overlay = {
      id: 'p20ov',
      tagName: 'DIV',
      className: '',
      textContent: '',
      parentElement: null,
      __style: {
        display,
        visibility: 'visible',
        opacity: '1',
        position: 'fixed',
        pointerEvents: 'auto',
        zIndex: '99999',
      },
      getBoundingClientRect: () => ({
        x: 0, y: 0, left: 0, top: 0, right: 1027, bottom: 632, width: 1027, height: 632,
      }),
      getAttribute: () => null,
      matches: () => false,
      contains(other) {
        for (let current = other; current; current = current.parentElement) {
          if (current === overlay) return true;
        }
        return false;
      },
    };
    const button = {
      id: 'p20btn',
      tagName: 'BUTTON',
      className: '',
      textContent: 'Continue',
      parentElement: null,
      __style: {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        position: 'static',
        pointerEvents: 'auto',
        zIndex: 'auto',
      },
      getBoundingClientRect: () => ({
        x: 40, y: 24, left: 40, top: 24, right: 120, bottom: 56, width: 80, height: 32,
      }),
      getAttribute: () => null,
      matches: () => false,
      contains(other) {
        return other === button;
      },
    };
    const elements = includeButton ? [button, overlay] : [overlay];
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCss = globalThis.CSS;
    const previousGetComputedStyle = globalThis.getComputedStyle;
    const previousElement = Object.getOwnPropertyDescriptor(globalThis, 'Element');
    globalThis.window = { innerWidth: 1042, innerHeight: 632, devicePixelRatio: 1 };
    globalThis.CSS = { escape: (value) => String(value) };
    globalThis.getComputedStyle = (element) => element.__style;
    globalThis.Element = class FixtureElement {
      static [Symbol.hasInstance](value) {
        return elements.includes(value);
      }
    };
    globalThis.document = {
      documentElement: { clientWidth: 1027, clientHeight: 632 },
      body: { clientWidth: 1027, clientHeight: 632 },
      querySelector: (selector) => elements.find(element => `#${element.id}` === selector) || null,
      querySelectorAll: (selector) => selector === 'body *'
        ? elements
        : elements.filter(element => element.matches(selector)),
      elementFromPoint: (x, y) => {
        const rect = overlay.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom && overlay.__style.display !== 'none') {
          return overlay;
        }
        return includeButton ? button : null;
      },
    };
    try {
      const runPageScript = Function('source', 'return eval(source);');
      return JSON.parse(runPageScript.call(null, source || T.overlayDetectorScript({ targetPoint })));
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.CSS = previousCss;
      globalThis.getComputedStyle = previousGetComputedStyle;
      if (previousElement) Object.defineProperty(globalThis, 'Element', previousElement);
      else delete globalThis.Element;
    }
  }

  it('#276 page-level overlay reports a visible fixed inset:0 overlay; scrollbar gutter must not hide it', async () => {
    const pageLevel = runP20OverlayPage();
    expect(pageLevel.schema).toBe('chrome-cdp-ex.overlays.v1');
    expect(pageLevel.overlayCount).toBeGreaterThanOrEqual(1);
    expect(pageLevel.blocking).toBe(true);
    expect(pageLevel.overlays[0]).toMatchObject({
      selector: '#p20ov',
      kind: 'overlay',
      blocking: true,
      coversViewport: true,
    });
    expect(pageLevel.overlays[0].rect).toEqual({ x: 0, y: 0, w: 1027, h: 632 });

    const targeted = runP20OverlayPage({
      includeButton: true,
      targetPoint: { input: '#p20btn', x: 80, y: 40, descriptor: '<BUTTON> "Continue"' },
    });
    expect(targeted.target.blocked).toBe(true);
    expect(targeted.overlayCount).toBeGreaterThanOrEqual(1);

    const hidden = runP20OverlayPage({ display: 'none' });
    expect(hidden).toMatchObject({ overlayCount: 0, blocking: false, overlays: [] });

    const cdp = {
      send(method, params = {}) {
        if (method !== 'Runtime.evaluate') return {};
        return { result: { value: JSON.stringify(runP20OverlayPage({ source: params.expression })) } };
      },
    };
    const json = JSON.parse(await T.overlayStr(cdp, 'sid1', '62E1DF19ABCDEF', ['--format', 'json']));
    expect(json.overlayCount).toBeGreaterThanOrEqual(1);
    expect(json.blocking).toBe(true);
    expect(json.overlays[0].selector).toBe('#p20ov');
    const text = await T.overlayStr(cdp, 'sid1', '62E1DF19ABCDEF', []);
    expect(text).toContain('Overlay detector: blocking');
    expect(text).not.toContain('Overlay detector: clear');
    expect(text).not.toContain('No visible blocking overlays/dialogs detected.');
  });

  it('#276 dismiss-modal does not claim no modal while a blocking overlay is still visible', async () => {
    const parsed = runP20OverlayPage({ source: T.dismissModalScript() });
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('overlay-not-dialog');
    expect(parsed.overlays).toContain('#p20ov');

    const cdp = {
      send(method) {
        if (method !== 'Runtime.evaluate') return {};
        return { result: { value: JSON.stringify(parsed) } };
      },
    };
    const out = await T.dismissModalStr(cdp, 'sid1');
    expect(out).toMatch(/only handles dialog\/modal/i);
    expect(out).toMatch(/#p20ov/);
    expect(out).not.toMatch(/No visible modal\/dialog detected/);
    expect(/no visible modal\/dialog detected/i.test(out)).toBe(false);
  });

  function guardParallelBatch(commands) {
    const unsafe = commands.filter(command => T.isBatchParallelUnsafeCommand(command.cmd, command.args || []));
    if (unsafe.length) {
      throw new Error(`batch --parallel: ${[...new Set(unsafe.map(command => command.cmd))].join(', ')} mutate shared state — use sequential batch`);
    }
    return commands;
  }

  it('#277 batch --parallel accepts cookies list with eval; cookieset/cookiedel stay sequential', async () => {
    const cookies = COMMAND_SURFACE.resolve('cookies');
    const cookieset = COMMAND_SURFACE.resolve('cookieset');
    const cookiedel = COMMAND_SURFACE.resolve('cookiedel');
    expect(cookies).toMatchObject({ mutates: false, kind: 'sensitive-read', authorization: 'sensitive-read' });
    expect(cookieset).toMatchObject({ mutates: true, kind: 'mutation' });
    expect(cookiedel).toMatchObject({ mutates: true, kind: 'mutation' });

    expect(T.isBatchParallelUnsafeCommand('cookies')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('eval', ['1+1'])).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('cookieset', ['a=b'])).toBe(true);
    expect(T.isBatchParallelUnsafeCommand('cookiedel', ['sid'])).toBe(true);

    const cookiesThenEval = T.parseBatchArgs(['--parallel', 'cookies | eval 1+1']);
    expect(cookiesThenEval.parallel).toBe(true);
    expect(cookiesThenEval.commands.map(command => command.cmd)).toEqual(['cookies', 'eval']);
    expect(() => guardParallelBatch(cookiesThenEval.commands)).not.toThrow();

    const evalThenCookies = T.parseBatchArgs(['--parallel', 'eval location.hostname | cookies']);
    expect(() => guardParallelBatch(evalThenCookies.commands)).not.toThrow();

    const results = await T.runBatchCommands({
      run: async (command) => {
        if (command.cmd === 'cookies') return { ok: true, result: 'No cookies' };
        if (command.cmd === 'eval') return { ok: true, result: '2' };
        throw new Error(`unexpected ${command.cmd}`);
      },
    }, cookiesThenEval.commands, { parallel: true });
    expect(results).toMatchObject([
      { cmd: 'cookies', ok: true, result: 'No cookies' },
      { cmd: 'eval', ok: true, result: '2' },
    ]);
    const formatted = T.formatBatchResults(results, 'plain');
    expect(formatted).toMatch(/No cookies/);
    expect(formatted).toMatch(/\b2\b/);

    expect(() => guardParallelBatch(T.parseBatchArgs(['--parallel', 'cookieset a=b | eval 1+1']).commands))
      .toThrow(/cookieset mutate shared state/);
    expect(() => guardParallelBatch(T.parseBatchArgs(['--parallel', 'cookiedel sid | eval 1+1']).commands))
      .toThrow(/cookiedel mutate shared state/);
    expect(() => guardParallelBatch(T.parseBatchArgs(['--parallel', 'cookies | eval 1+1']).commands))
      .not.toThrow(/cookies mutate shared state/);

    const mutationError = T.formatCliError(
      new Error('batch --parallel: cookieset mutate shared state — use sequential batch'),
      { cmd: 'batch', targetPrefix: '62E1DF19' },
    );
    expect(mutationError).toMatch(/Kind: usage/);
    expect(mutationError).toMatch(/Next: cdp help batch/);
    expect(mutationError).not.toMatch(/cookies mutate shared state/);
  });
});





