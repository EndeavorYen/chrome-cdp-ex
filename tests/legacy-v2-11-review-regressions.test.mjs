import { describe, expect, it } from 'vitest';

import { runInNewContext } from 'node:vm';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { MCP_TOOL_DEFINITIONS, buildMcpToolCommand } = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');

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
    expect(controls).toBeUndefined();
    expect(report).toBeUndefined();
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
    expect(text).toContain('Kind: invalid-selector');
    expect(text).not.toContain('Kind: unknown');
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

  it.skipIf(process.platform === 'win32')('keys daemon git identity off the script package root, not process.cwd (#130)', async () => {
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
      display: { platform: 'linux', env: { DISPLAY: ':0' } },
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
    expect(r.relaunch).toBe('/opt/chromium/chrome --remote-debugging-port=9224 --user-data-dir=/tmp/real-x-profile');
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
      relaunch: expect.stringContaining('--user-data-dir=/tmp/real-x-profile'),
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
    const relaunch = '/opt/chromium/chrome --remote-debugging-port=9224 --user-data-dir=/tmp/real-x-profile';

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
    expect(text).toContain(`Next: ${relaunch}`);
    expect(text).not.toMatch(/spawn-debug-browser|rm -rf|Profile is disposable/);
    expect(text).not.toMatch(/perceive .* -C -d 8/);
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
        relaunch: expect.stringContaining('--user-data-dir=/tmp/real-x-profile'),
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
    const result = T.checkSkillSymlink({ home, fs, env: {} });
    expect(result.status).toBe('OK');
    expect(result.detail).toContain(hermesPath);
    expect(result.detail).not.toMatch(/not found/);
  });

  it('#154 hints ~/.hermes/skills when no host skill path exists', () => {
    const result = T.checkSkillSymlink({
      home: '/home/test',
      env: {},
      fs: { existsSync: () => false },
    });
    expect(result.status).toBe('WARN');
    expect(result.hint).toContain('~/.hermes/skills');
  });
});
