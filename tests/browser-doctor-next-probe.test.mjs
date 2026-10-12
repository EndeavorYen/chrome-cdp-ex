import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

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
    expect(model.wizard.currentStep).toBe('cdp list');
    expect(model.wizard.currentStep).not.toContain('6669325B');
    expect(permission.provenCommand).toBe('cdp list');
    expect(text).toBe('Node: v22\nCDP: reachable\nNext: cdp list');
    expect(text).not.toMatch(/perceive 6669325B/);
    expect(model.nextSteps).toEqual(['cdp list']);
    expect(model.nextSteps.join('\n')).not.toMatch(/perceive/);
    expect(model.recommendedTargetPrefix).not.toBe('6669325B');
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
    expect(single.provenCommand).toBe('cdp list');
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
