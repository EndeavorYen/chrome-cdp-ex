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
      'report',
    ]));
    expect(createMcpInitializeResult().serverInfo.name).toBe('chrome-cdp-ex');
    expect(createMcpInitializeResult().serverInfo.version).toBe(packageJson.version);
    expect(buildMcpToolCommand('doctor', {})).toEqual(['doctor', '--format', 'json']);
    expect(buildMcpToolCommand('perceive', { target: 'app', depth: 4, cursorInteractive: true }))
      .toEqual(['perceive', 'app', '-d', '4', '-C', '--format', 'json']);
    expect(buildMcpToolCommand('controls', { target: 'app', selector: '#composer', filter: 'send', limit: 5 }))
      .toEqual(['controls', 'app', '--selector', '#composer', '--filter', 'send', '--limit', '5', '--format', 'json']);
    expect(buildMcpToolCommand('overlay', { target: 'app', selector: '@3' }))
      .toEqual(['overlay', 'app', '@3', '--format', 'json']);
    expect(buildMcpToolCommand('open_or_attach', { target: 'ABC12345', port: 9223 }))
      .toEqual(['use', '--port', '9223', '--target', 'ABC12345']);
    expect(buildMcpToolCommand('click', { target: 'app', selector: 'button.primary', confirm: true }))
      .toEqual(['click', 'app', 'button.primary', '--format', 'json']);
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
