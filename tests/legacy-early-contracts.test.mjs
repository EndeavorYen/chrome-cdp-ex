import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
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
    // #439: an untouched target counts as remaining only while its daemon answers.
    const otherSessionAnswers = async path => {
      if (path === remainingDaemon.socketPath) return { destroy: () => {} };
      throw new Error('ECONNREFUSED');
    };
    const repeatedWithOtherSession = await T.stopDaemons('ABCDEF12', {
      list: () => [remainingDaemon],
      connect: otherSessionAnswers,
    });
    const failedCleanup = await T.stopDaemons('ABCDEF12', {
      list: () => [daemon, remainingDaemon],
      connect: otherSessionAnswers,
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
    expect(T.parseConsoleArgs(['--clear', '--format', 'json'])).toEqual({ mode: 'clear', format: 'json', unsafeFull: false });
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
      run: 'cdp spawn-debug-browser chrome --headless --no-sandbox --port 9222 --user-data-dir /tmp/chrome-cdp-ex-chrome-debug-profile-9222 --exe /usr/bin/chromium --url https://example.com',
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
      'list_tabs',
      'perceive',
      'screenshot',
      'click',
      'dismiss_modal',
      'fill',
      'navigate',
      'press',
      'wait_for',
      'cascade',
      'spawn_debug_browser',
      'run_command',
    ]));
    for (const hidden of ['select_target', 'controls', 'overlay', 'verify_click', 'viewport', 'qa_page', 'responsive_audit', 'report', 'components', 'record_snapshot', 'session_checkpoint']) {
      expect(toolNames, hidden).not.toContain(hidden);
    }
    expect(createMcpInitializeResult().serverInfo.name).toBe('chrome-cdp-ex');
    expect(createMcpInitializeResult().serverInfo.version).toBe(packageJson.version);
    expect(buildMcpToolCommand('doctor', {})).toEqual(['doctor']);
    expect(buildMcpToolCommand('perceive', { target: 'app', depth: 4, cursorInteractive: true }))
      .toEqual(['perceive', 'app', '-d', '4', '-C', '--adaptive']);
    expect(buildMcpToolCommand('perceive', { target: 'app', cards: true, last: 12 }))
      .toEqual(['perceive', 'app', '--cards', '--last', '12']);
    expect(buildMcpToolCommand('perceive', { target: 'app', qa: true, maxDiffLines: 12 }))
      .toEqual(['perceive', 'app', '--adaptive', '--qa', '--max-diff-lines', '12']);
    expect(buildMcpToolCommand('controls', { target: 'app', selector: '#composer', filter: 'send', limit: 5 }))
      .toEqual(['controls', 'app', '--selector', '#composer', '--filter', 'send', '--limit', '5', '--compact']);
    expect(buildMcpToolCommand('overlay', { target: 'app', selector: '@3' }))
      .toEqual(['overlay', 'app', '@3']);
    expect(buildMcpToolCommand('open_or_attach', { target: 'ABC12345', port: 9223 }))
      .toEqual(['use', '--port', '9223', '--target', 'ABC12345']);
    expect(buildMcpToolCommand('open_or_attach', { url: 'https://example.com', reuseUrl: true, confirm: true }))
      .toEqual(['open', 'https://example.com', '--reuse-url']);
    expect(buildMcpToolCommand('select_target', { url: '8788', title: 'Lab' }))
      .toEqual(['target', '--url', '8788', '--title', 'Lab']);
    expect(buildMcpToolCommand('click', { target: 'app', selector: 'button.primary', confirm: true }))
      .toEqual(['click', 'app', 'button.primary']);
    expect(buildMcpToolCommand('click', { target: 'app', selector: 'button.primary', qa: true, confirm: true }))
      .toEqual(['click', 'app', 'button.primary', '--qa']);
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
    ]);
    expect(buildMcpToolCommand('dismiss_modal', { target: 'app', confirm: true }))
      .toEqual(['dismiss-modal', 'app']);
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
    ]);
    expect(() => buildMcpToolCommand('responsive_audit', { target: 'app' }))
      .toThrow(/confirm: true/);
    expect(buildMcpToolCommand('report', { target: 'app', qa: true, last: 3 }))
      .toEqual(['report', 'app', '--last', '3', '--qa']);
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
    expect(responses[0].result.protocolVersion).toBe('2025-06-18');
    const toolNames = responses[1].result.tools.map(tool => tool.name);
    expect(toolNames).toContain('perceive');
    expect(toolNames).not.toContain('qa_page');
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
      'chrome', '--port', '9444', '--url', 'https://example.com', '--exe', '/opt/chromium/chrome',
      '--user-data-dir', '/tmp/chrome-cdp-ex-chrome-debug-profile-9444', '--format', 'json',
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
    // #428: the selector is a single-quoted JS string inside the double-quoted shell argument.
    expect(err).toContain(`cdp eval <target> "document.querySelector('#promptBlock')?.textContent"`);
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
      stage: 'list',
      requiresUserAction: false,
      ask: null,
    });
  });
});

describe('issues #89-#91 contracts', () => {
  it('#89 maps new MCP tools for target selection and responsive audit', () => {
    expect(MCP_TOOL_DEFINITIONS.map(tool => tool.name)).not.toContain('select_target');
    expect(MCP_TOOL_DEFINITIONS.map(tool => tool.name)).not.toContain('responsive_audit');
    expect(buildMcpToolCommand('select_target', { url: 'http://127.0.0.1:8788', exact: true }))
      .toEqual(['target', '--url', 'http://127.0.0.1:8788', '--exact']);
    expect(() => buildMcpToolCommand('responsive_audit', { target: 'app' }))
      .toThrow(/confirm: true/);
    expect(buildMcpToolCommand('responsive_audit', { target: 'app', confirm: true }))
      .toEqual(['responsive-audit', 'app']);
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

});
