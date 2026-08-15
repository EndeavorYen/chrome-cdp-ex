import { describe, expect, it } from 'vitest';
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
    const cdp = {
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: 'https://example.com/' } });
        }
        if (method === 'Network.getCookies') {
          return Promise.resolve({ cookies: [{ name: 'picky5', value: 'roundtrip' }] });
        }
        if (method === 'Network.deleteCookies') return Promise.resolve({});
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

