import { describe, expect, it } from 'vitest';

import { readFileSync } from 'fs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

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
    // #464: one bounded settle budget that fits inside the ref-resolve CDP timeout.
    expect(T.scrollSettledRectFunctionDeclaration()).toContain(`Date.now() + ${T.REF_SETTLE_BUDGET_MS}`);
    expect(T.REF_SETTLE_BUDGET_MS).toBeLessThan(T.REF_RESOLVE_TIMEOUT);
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
    expect(bin).toContain('startChromeCdpCli');
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
      env: {},
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
