import { describe, expect, it, vi } from 'vitest';

import { runtimeSource } from './runtime-source.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

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
    const listSockets = vi.fn(() => [{ targetId: 'OTHER', socketPath: '/tmp/other-port.sock' }]);
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
      listSockets,
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
    expect(listSockets).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(resolveWsUrl).toHaveBeenCalledOnce();
    expect(connectCdp).toHaveBeenCalledOnce();
    expect(cdp.close).toHaveBeenCalledOnce();

    await expect(T.discoverLivePagesForTargetResolution({
      env: { CDP_PORT: '9224', CDP_HOST: '127.0.0.1' },
      pinCdpPort: true,
      listSockets,
      connect,
      request,
      resolveWsUrl: async () => {
        throw new Error('cannot reach cdp on 127.0.0.1:9224');
      },
      connectCdp,
      listPages,
    })).rejects.toThrow(/cannot reach cdp on 127\.0\.0\.1:9224/i);
    expect(listSockets).not.toHaveBeenCalled();

    // #419: the daemon must prove it is attached to the requested endpoint before its list is used.
    const unpinned = await T.discoverLivePagesForTargetResolution({
      env: { CDP_PORT: '9345' },
      pinCdpPort: false,
      listSockets: () => [{ targetId: 'DAEMON', socketPath: '/tmp/daemon.sock' }],
      connect: async () => ({ end() {}, destroy() {} }),
      request: async (_conn, req) => (req.cmd === 'meta'
        ? { ok: true, result: JSON.stringify({ cdpEndpoint: '127.0.0.1:9345' }) }
        : { ok: true, result: JSON.stringify([{ targetId: 'DAEMONONLYFULLID' }]) }),
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

    const src = runtimeSource();
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
    // #546: the page command resolves through resolvePageCommandTarget, whose discovery is
    // livePagesForTargetCommand.
    expect(targetCmd).toMatch(/await resolvePageCommandTarget\(\{\s*targetPrefix,\s*targetAlias,/);
    expect(targetCmd).not.toMatch(/function livePagesForTargetCommand/);
    expect(targetCmd).not.toMatch(/\bdiscover\s*:/);
    expect(src).toMatch(/async function resolvePageCommandTarget\(\{[\s\S]{0,200}discover = livePagesForTargetCommand,/);
    expect(targetCmd).not.toMatch(/targetAlias\?\.port[\s\S]{0,200}cachedPages/);
  });
});
