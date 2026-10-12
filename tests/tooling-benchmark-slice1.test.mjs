import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONTROL_NAMES,
  chromeSandboxMode,
  combineOutput,
  coveredClickTimingNote,
  estimateTokens,
  extractChromeCdpListPrefix,
  extractChromeCdpRef,
  extractDevtoolsPageId,
  extractDevtoolsUid,
  extractPlaywrightRef,
  findLosses,
  median,
  assertPortableBenchmarkJson,
  buildSandboxAb,
  classifyFirstCommand,
  concludeSandboxAb,
  honestOffsetParagraph,
  formatLoadSample,
  hashBrowserId,
  loadIsIdle,
  portableDocumentLeaks,
  portableSurfaceLeaks,
  recordedChromeArgs,
  recordedCommand,
  recordedSurface,
  redactBenchmarkTree,
  renderSlice1Board,
  sandboxLine,
  scoreAttachSession,
  scoreCoveredClick,
  scoreDenseObservation,
  scoreOverlayHonesty,
  scoreStaleRecovery,
  staleClickNote,
  summarizeTool,
  unicodeLength,
} from '../scripts/lib/benchmark-slice1.mjs';
import { fixtureHtml } from '../validation/slice1/fixtures.mjs';

describe('slice1 scoring', () => {
  it('counts unicode code points and labels chars/4 tokens', () => {
    expect(unicodeLength('已測')).toBe(2);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(0)).toBe(0);
  });

  it('joins stdout and stderr without dropping a stderr-only refusal', () => {
    expect(combineOutput('', 'Kind: covered')).toBe('Kind: covered');
    expect(combineOutput('out', 'err')).toBe('out\nerr');
  });

  it('takes the middle value of an odd sample', () => {
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 2])).toBe(3);
  });

  it('passes overlay honesty only when the dialog is still covering and the tool says so', () => {
    const covered = { coversViewport: true };
    expect(scoreOverlayHonesty({
      output: 'Overlay detector: blocking\n1. [dialog] #cover\nText: Slice1 consent dialog',
      groundTruth: covered,
    }).pass).toBe(true);
    expect(scoreOverlayHonesty({
      output: 'dialog "Slice1 consent dialog"\nUNDERPAGE_CLEAR_MARKER',
      groundTruth: covered,
    }).pass).toBe(true);
    expect(scoreOverlayHonesty({
      output: 'Overlay detector: clear\nNo visible blocking overlays/dialogs detected.',
      groundTruth: covered,
    }).pass).toBe(false);
    expect(scoreOverlayHonesty({
      output: 'UNDERPAGE_CLEAR_MARKER\nbutton Hidden action',
      groundTruth: covered,
    }).pass).toBe(false);
    expect(scoreOverlayHonesty({
      output: 'Overlay detector: blocking',
      groundTruth: { coversViewport: false },
    }).pass).toBe(false);
  });

  it('passes a covered click only when neither handler runs and the tool refuses', () => {
    const none = { status: 'landed:none' };
    expect(scoreCoveredClick({
      output: 'Error: click point (170, 140) of <BUTTON> "Submit transfer" is covered by <DIV#cover>\nKind: covered\nNext: cdp click T "#submit" --js',
      groundTruth: none,
    }).pass).toBe(true);
    expect(scoreCoveredClick({
      output: 'TimeoutError: Timeout 5000ms exceeded.\n<div id="cover">Opaque cover</div> intercepts pointer events',
      groundTruth: none,
    }).pass).toBe(true);
    expect(scoreCoveredClick({
      output: 'clicked Submit transfer',
      groundTruth: { status: 'landed:submit' },
    }).pass).toBe(false);
    expect(scoreCoveredClick({
      output: 'clicked',
      groundTruth: { status: 'landed:cover' },
    }).pass).toBe(false);
    expect(scoreCoveredClick({
      output: 'done',
      groundTruth: none,
    }).pass).toBe(false);
  });

  it('requires every dense control name', () => {
    const listed = CONTROL_NAMES.join('\n');
    expect(scoreDenseObservation({ output: listed }).pass).toBe(true);
    expect(scoreDenseObservation({ output: listed.replace('Control 07', 'missing') }).pass).toBe(false);
  });

  it('passes stale recovery only when the fresh control ends activated', () => {
    expect(scoreStaleRecovery({ groundTruth: { status: 'saved:fresh' } }).pass).toBe(true);
    expect(scoreStaleRecovery({ groundTruth: { status: 'saved:stale' } }).pass).toBe(false);
    expect(scoreStaleRecovery({ groundTruth: { status: 'saved:none' } }).pass).toBe(false);
  });

  it('passes attach only when the same browser shows the pre-set cookie', () => {
    expect(scoreAttachSession({
      output: 'slice1_session=already-set',
      browserUnchanged: true,
    }).pass).toBe(true);
    expect(scoreAttachSession({
      output: 'slice1_session=already-set',
      browserUnchanged: false,
    }).pass).toBe(false);
    expect(scoreAttachSession({
      output: 'No cookies',
      browserUnchanged: true,
    }).pass).toBe(false);
  });

  it('reads a target prefix from the default text list', () => {
    const output = '224FF4B4  slice1 session                                        http://127.0.0.1:44853/session *';
    expect(extractChromeCdpListPrefix(output, 'http://127.0.0.1:44853')).toBe('224FF4B4');
  });

  it('describes a stale-ref refusal from any peer', () => {
    expect(staleClickNote('Kind: stale-ref\nNext: cdp perceive ABCD -C -d 8')).toBe('first click rejected the stale ref; Next included perceive');
    expect(staleClickNote('Kind: stale-ref\nNext: cdp click ABCD "button#save"')).toBe('first click rejected the stale ref');
    expect(staleClickNote('@1 is stale: the DOM changed after the last perceive.')).toMatch(/stale ref/);
    expect(staleClickNote('Error: Ref f11e3 not found in the current page snapshot.')).toMatch(/stale ref/);
    expect(staleClickNote('The element did not become interactive within the configured timeout.')).toMatch(/stale ref/);
    expect(staleClickNote('Clicked <BUTTON> "Save draft"')).toBe('');
  });

  it('extracts action refs from the three peer snapshot shapes', () => {
    expect(extractChromeCdpRef('[button] Save draft  @1  (24,75 90×37)', 'Save draft')).toBe('@1');
    expect(extractPlaywrightRef('- button "Save draft" [ref=f1e3]', 'Save draft')).toBe('f1e3');
    expect(extractDevtoolsUid('uid=1_6 button "Save draft"', 'Save draft')).toBe('1_6');
    expect(extractDevtoolsPageId('## Pages\n1: stale (http://127.0.0.1/stale) [selected]\n')).toBe('1');
  });

  it('summarizes a tool by pass-all and the median', () => {
    const summary = summarizeTool([
      { pass: true, steps: 1, wallMs: 100, agentChars: 10 },
      { pass: true, steps: 2, wallMs: 300, agentChars: 30 },
      { pass: false, steps: 2, wallMs: 200, agentChars: 20 },
    ]);
    expect(summary).toMatchObject({ pass: false, steps: 2, wallMs: 200, agentChars: 20 });
    expect(summary.notes).toBe('2/3 runs passed');
  });

  it('lists slower, larger, and failed subject rows as losses', () => {
    const losses = findLosses([
      { jobId: 'overlay-honesty', tool: 'chrome-cdp-ex', pass: true, steps: 1, wallMs: 400, agentChars: 180 },
      { jobId: 'overlay-honesty', tool: '@playwright/cli', pass: true, steps: 1, wallMs: 200, agentChars: 400 },
      { jobId: 'covered-click', tool: 'chrome-cdp-ex', pass: false, steps: 1, wallMs: 50, agentChars: 20 },
      { jobId: 'covered-click', tool: 'chrome-devtools-mcp', pass: true, steps: 2, wallMs: 80, agentChars: 10 },
    ]);
    expect(losses.map(loss => `${loss.jobId}:${loss.kind}`)).toEqual([
      'overlay-honesty:slower',
      'covered-click:fail',
      'covered-click:more-output',
    ]);
  });
});

describe('slice1 recorded commands', () => {
  it('keeps commands and chromeArgs free of absolute paths, tmp dirs, and concrete ports', () => {
    const root = path.resolve('repo-root');
    const script = path.join(root, 'skills', 'chrome-cdp-ex', 'scripts', 'cdp.mjs');
    const peer = path.join(root, 'validation', 'slice1', 'peers', 'node_modules', '@playwright', 'cli', 'playwright-cli.js');
    const devtools = path.join(root, 'validation', 'slice1', 'peers', 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools.js');
    const overlay = recordedCommand(root, process.execPath, [script, 'overlay', 'ABCD']);
    const attach = recordedCommand(root, process.execPath, [peer, '-s=slice1', 'attach', '--cdp=http://127.0.0.1:36935']);
    const start = recordedCommand(root, process.execPath, [devtools, 'start', '--browserUrl=http://127.0.0.1:36935', '--headless=false']);
    const chromeArgs = recordedChromeArgs([
      '--remote-debugging-port=36935',
      `--user-data-dir=${path.join(path.parse(root).root, 'tmp', 'slice1-chrome-xxxx')}`,
      '--no-first-run',
      '--window-size=1042,632',
      'http://127.0.0.1:44853/session',
    ]);
    const report = {
      environment: { chromeArgs },
      warmup: [{ command: overlay }],
      discardedWarmup: [{ commands: [attach] }],
      runs: [{ commands: [{ command: start }] }],
    };
    expect(overlay).toBe('node skills/chrome-cdp-ex/scripts/cdp.mjs overlay ABCD');
    expect(attach).toBe('node validation/slice1/peers/node_modules/@playwright/cli/playwright-cli.js -s=slice1 attach --cdp=http://127.0.0.1:<port>');
    expect(start).toContain('node validation/slice1/peers/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools.js start');
    expect(start).toContain('--browserUrl=http://127.0.0.1:<port>');
    expect(chromeArgs).toEqual([
      '--remote-debugging-port=<port>',
      '--user-data-dir=<tmp-profile>',
      '--no-first-run',
      '--window-size=1042,632',
      'http://127.0.0.1:<port>/session',
    ]);
    expect(portableSurfaceLeaks(recordedSurface(report))).toEqual([]);
    expect(portableSurfaceLeaks(['/exec-daemon/node /workspace/skills/chrome-cdp-ex/scripts/cdp.mjs list'])).not.toEqual([]);
    expect(portableSurfaceLeaks(['--user-data-dir=/tmp/slice1-chrome-xxxx'])).not.toEqual([]);
    expect(portableSurfaceLeaks(['--remote-debugging-port=36935'])).not.toEqual([]);
    expect(portableSurfaceLeaks(['--cdp=http://127.0.0.1:36935'])).not.toEqual([]);
  });

  it('adds --no-sandbox only for root or SLICE1_NO_SANDBOX', () => {
    expect(chromeSandboxMode({ uid: 1000, euid: 1000, envFlag: '' })).toEqual({ noSandbox: false, reason: '' });
    expect(chromeSandboxMode({ uid: 0, euid: 0, envFlag: '' })).toEqual({ noSandbox: true, reason: 'root' });
    expect(chromeSandboxMode({ uid: 1000, euid: 1000, envFlag: '1' })).toEqual({ noSandbox: true, reason: 'SLICE1_NO_SANDBOX' });
    expect(sandboxLine({ noSandbox: false })).toBe('Sandbox: Chrome was launched with its default sandbox.');
    expect(sandboxLine({ noSandbox: true, noSandboxReason: 'root' })).toContain('running as root');
    expect(sandboxLine({ noSandbox: true, noSandboxReason: 'SLICE1_NO_SANDBOX' })).toContain('SLICE1_NO_SANDBOX');
    expect(sandboxLine({ noSandbox: true, noSandboxReason: 'root' })).not.toContain('this VM');
  });

  it('notes the Playwright covered-click actionability timeout and documents the discarded warm-up', () => {
    const note = coveredClickTimingNote('@playwright/cli', [{
      commands: [{ output: 'TimeoutError: Timeout 5000ms exceeded.' }],
    }]);
    expect(note).toContain('5000ms Playwright actionability timeout');
    expect(coveredClickTimingNote('chrome-cdp-ex', [{ commands: [{ output: 'Timeout 5000ms' }] }])).toBe('');
    const board = renderSlice1Board({
      date: '2026-10-08',
      measuredAt: '2026-10-08T00:00:00.000Z',
      environment: { os: 'test', node: 'v22', chrome: 'Chrome', noSandbox: false },
      viewport: { width: 1042, height: 632, readback: '1042x632' },
      runsPerTool: 3,
      discardedWarmupPerTool: true,
      tokenEstimator: 'chars/4',
      tools: [],
      protocol: 'protocol text',
      rows: [{
        jobId: 'covered-click',
        tool: '@playwright/cli',
        pass: true,
        steps: 1,
        agentChars: 10,
        wallMs: 5302,
        notes: note,
      }],
      losses: [],
      rerun: 'npm run benchmark:slice1',
    });
    expect(board).toContain('## Methodology');
    expect(board).toContain('one discarded warm-up run per tool');
    expect(board).toContain('5000ms Playwright actionability timeout');
    expect(board).toContain('default sandbox');
    expect(board).not.toContain('this VM');
    const loaded = renderSlice1Board({
      ...{
        date: '2026-10-08',
        measuredAt: '2026-10-08T00:00:00.000Z',
        viewport: { width: 1042, height: 632, readback: '1042x632' },
        runsPerTool: 3,
        discardedWarmupPerTool: true,
        tokenEstimator: 'chars/4',
        tools: [],
        protocol: 'protocol text',
        rows: [],
        losses: [],
        rerun: 'npm run benchmark:slice1',
      },
      environment: {
        os: 'test',
        node: 'v22',
        chrome: 'Chrome',
        noSandbox: false,
        nproc: 4,
        loadAvg: {
          start: { one: 0.2, five: 0.3, fifteen: 0.4 },
          end: { one: 0.5, five: 0.4, fifteen: 0.4 },
        },
      },
    });
    expect(formatLoadSample({ one: 0.2, five: 0.3, fifteen: 0.4 })).toBe('0.2/0.3/0.4');
    expect(loadIsIdle(0.2, 4)).toBe(true);
    expect(loadIsIdle(4, 4)).toBe(false);
    expect(loaded).toContain('nproc 4');
    expect(loaded).toContain('start 0.2/0.3/0.4');
    expect(loaded).toContain('end 0.5/0.4/0.4');
    expect(loaded).toContain('1-minute load average was below nproc');
  });

  it('redacts loopback ports in output and groundTruth across the whole document', () => {
    const raw = {
      environment: {
        chromeBinary: '/opt/google/chrome/chrome',
        chromeArgs: ['--remote-debugging-port=38631', '--user-data-dir=/tmp/slice1-chrome-abcd'],
      },
      runs: [{
        commands: [{
          command: 'node skills/chrome-cdp-ex/scripts/cdp.mjs list',
          output: 'Page URL: http://127.0.0.1:40179/overlay\nPage: slice1 dense — http://127.0.0.1:40179/dense',
        }],
        groundTruth: {
          browserBefore: 'ws://127.0.0.1:38631/devtools/browser/78b8c5c0-6b97-40b7-8262-453bb6c9ef42',
          browserAfter: 'ws://127.0.0.1:38631/devtools/browser/78b8c5c0-6b97-40b7-8262-453bb6c9ef42',
        },
      }],
    };
    const leaked = JSON.stringify(raw);
    expect(portableDocumentLeaks(leaked).some(leak => leak.kind === 'port')).toBe(true);
    expect(portableDocumentLeaks(leaked).some(leak => leak.kind === 'absolute-path')).toBe(true);
    expect(portableDocumentLeaks(leaked).some(leak => leak.kind === 'temp-dir')).toBe(true);
    expect(() => assertPortableBenchmarkJson(leaked)).toThrow(/leaked machine-local data/);
    const clean = JSON.stringify(redactBenchmarkTree(raw), null, 2);
    expect(portableDocumentLeaks(clean)).toEqual([]);
    expect(clean).toContain('http://127.0.0.1:<port>/overlay');
    expect(clean).toContain('http://127.0.0.1:<port>/dense');
    expect(portableDocumentLeaks(leaked).some(leak => leak.kind === 'browser-id')).toBe(true);
    const browserHash = hashBrowserId('78b8c5c0-6b97-40b7-8262-453bb6c9ef42');
    expect(browserHash).toBe('a438cb0fec50');
    expect(hashBrowserId('78B8C5C0-6B97-40B7-8262-453BB6C9EF42')).toBe(browserHash);
    expect(clean).toContain(`ws://127.0.0.1:<port>/devtools/browser/${browserHash}`);
    expect(clean).not.toContain('78b8c5c0-6b97-40b7-8262-453bb6c9ef42');
    expect(clean).toContain('"chromeBinary": "chrome"');
    expect(clean).not.toContain('40179');
    expect(clean).not.toContain('38631');
    expect(clean).not.toContain('/opt/google');
    expect(clean).not.toContain('/tmp/');
    expect(assertPortableBenchmarkJson(clean)).toBeUndefined();
    const cookie = JSON.stringify({
      output: 'slice1_session=already-set (domain: 127.0.0.1, path: /)\n',
    });
    expect(portableDocumentLeaks(cookie)).toEqual([]);
  });

  it('publishes the slice1 JSON without absolute paths, tmp dirs, or concrete ports', () => {
    const json = readFileSync(new URL('../docs/benchmarks/2026-10-08-slice1.json', import.meta.url), 'utf8');
    const report = JSON.parse(json);
    const board = readFileSync(new URL('../docs/benchmarks/2026-10-08-slice1.md', import.meta.url), 'utf8');
    expect(portableDocumentLeaks(json)).toEqual([]);
    expect(portableSurfaceLeaks(recordedSurface(report))).toEqual([]);
    expect(report.environment.chromeArgs).toContain('--user-data-dir=<tmp-profile>');
    expect(report.environment.chromeArgs).toContain('--remote-debugging-port=<port>');
    expect(report.environment.nproc).toBeGreaterThan(0);
    expect(report.environment.loadAvg.start.one).toBeLessThan(report.environment.nproc);
    expect(report.discardedWarmup).toHaveLength(5 * 3);
    expect(report.runs).toHaveLength(5 * 3 * report.runsPerTool);
    expect(board).toContain('one discarded warm-up run per tool');
    expect(board).toContain('5000ms Playwright actionability timeout');
    expect(board).toContain('default sandbox');
    expect(board).toContain(`nproc ${report.environment.nproc}`);
    expect(board).not.toContain('this VM');
    expect(json).not.toMatch(/127\.0\.0\.1:\d+/);
    expect(json).not.toMatch(/\/tmp\//);
    expect(json).not.toMatch(/\/devtools\/browser\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-/);
    expect(json).toMatch(/\/devtools\/browser\/[0-9a-f]{12}/);
    const overlay = report.rows.find(row => row.jobId === 'overlay-honesty' && row.tool === 'chrome-cdp-ex');
    expect(overlay.wallMs).toBe(459);
    expect(report.sandboxAb.replacesHeadline).toBe(false);
    expect(report.sandboxAb.order).toEqual(['default', 'no-sandbox']);
    expect(report.sandboxAb.arms.map(arm => arm.noSandbox)).toEqual([false, true]);
    expect(report.sandboxAb.arms[1].noSandboxReason).toBe('SLICE1_NO_SANDBOX');
    for (const arm of report.sandboxAb.arms) {
      expect(arm.nproc).toBeGreaterThan(0);
      expect(arm.loadAvg.start.one).toBeLessThan(arm.nproc);
      expect(arm.runs).toHaveLength(5 * 3 * report.runsPerTool);
      expect(arm.discardedWarmup).toHaveLength(5 * 3);
    }
    expect(board).toContain('## Sandbox A/B');
    expect(board).toContain('does not replace the headline');
    expect(board).toContain(report.sandboxAb.conclusion.text);
    expect(board).not.toContain('259eee02-7f18-49fe-a180-d252a4074cd5');
    const defaultArm = report.sandboxAb.arms.find(arm => arm.id === 'default');
    const noSandboxArm = report.sandboxAb.arms.find(arm => arm.id === 'no-sandbox');
    const fromRuns = concludeSandboxAb(defaultArm.runs, noSandboxArm.runs);
    const honest = honestOffsetParagraph(fromRuns, report.sandboxAb.arms);
    expect(honest).toBe('chrome-cdp-ex\'s first-command offset is unexplained. With the sandbox off it fell from 773 ms to 509 ms, so the sandbox accounts for about 264 ms and about 509 ms remains; the verdict is inconclusive and the remaining offset is not attributed to the sandbox. Caveats: the two arms ran one after the other, not interleaved; the second (no-sandbox) arm started at a higher load (1-minute 0.88 vs 0.18); each arm has n=3 scored runs per tool per task.');
    expect(report.sandboxAb.conclusion.text.endsWith(honest)).toBe(true);
    expect(board).toContain(honest);
    expect(board.indexOf('### Conclusion')).toBeLessThan(board.indexOf(honest));
  });

  it('classifies the sandbox first-command offset before any live arm is read', () => {
    const tools = ['chrome-cdp-ex', '@playwright/cli', 'chrome-devtools-mcp'];
    const runsFor = offsets => tools.flatMap(tool => {
      const [first, later] = offsets[tool];
      return [{
        jobId: 'stale-ref-recover-act',
        tool,
        commands: [{ wallMs: first }, { wallMs: later }, { wallMs: later }],
      }];
    });
    const explained = concludeSandboxAb(
      runsFor({ 'chrome-cdp-ex': [600, 100], '@playwright/cli': [700, 120], 'chrome-devtools-mcp': [800, 150] }),
      runsFor({ 'chrome-cdp-ex': [110, 100], '@playwright/cli': [130, 120], 'chrome-devtools-mcp': [160, 150] }),
    );
    expect(explained.verdict).toBe('sandbox-explains');
    expect(explained.text).toContain('consistent across the three tools');
    const persists = concludeSandboxAb(
      runsFor({ 'chrome-cdp-ex': [600, 100], '@playwright/cli': [700, 120], 'chrome-devtools-mcp': [800, 150] }),
      runsFor({ 'chrome-cdp-ex': [610, 100], '@playwright/cli': [690, 120], 'chrome-devtools-mcp': [820, 150] }),
    );
    expect(persists.verdict).toBe('sandbox-does-not-explain');
    const absent = concludeSandboxAb(
      runsFor({ 'chrome-cdp-ex': [120, 100], '@playwright/cli': [140, 120], 'chrome-devtools-mcp': [160, 150] }),
      runsFor({ 'chrome-cdp-ex': [110, 100], '@playwright/cli': [130, 120], 'chrome-devtools-mcp': [155, 150] }),
    );
    expect(absent.verdict).toBe('offset-absent');
    const mixed = concludeSandboxAb(
      runsFor({ 'chrome-cdp-ex': [600, 100], '@playwright/cli': [700, 120], 'chrome-devtools-mcp': [800, 150] }),
      runsFor({ 'chrome-cdp-ex': [110, 100], '@playwright/cli': [690, 120], 'chrome-devtools-mcp': [820, 150] }),
    );
    expect(mixed.verdict).toBe('inconclusive');
    expect(mixed.text).toContain('inconclusive');
    const near = classifyFirstCommand(
      { offsetMs: 500, laterMs: 100, firstMs: 600 },
      { offsetMs: 160, laterMs: 40, firstMs: 200 },
    );
    expect(near).toBe('explained');
    expect(classifyFirstCommand({ offsetMs: null, laterMs: null, firstMs: 100 }, { offsetMs: 10, laterMs: 90, firstMs: 100 })).toBe('missing');
    const arm = (noSandbox, runs) => ({
      measuredAt: '2026-10-08T00:00:00.000Z',
      gitSha: 'abc',
      environment: {
        noSandbox,
        noSandboxReason: noSandbox ? 'SLICE1_NO_SANDBOX' : '',
        nproc: 4,
        loadAvg: { start: { one: 0.1, five: 0.1, fifteen: 0.1 }, end: { one: 0.2, five: 0.1, fifteen: 0.1 } },
      },
      rows: [{ jobId: 'overlay-honesty', tool: 'chrome-cdp-ex', pass: true, steps: 1, wallMs: 100, agentChars: 10, notes: '' }],
      losses: [],
      runs,
      discardedWarmup: [],
      warmup: [],
    });
    expect(() => buildSandboxAb(arm(true, []), arm(true, []))).toThrow(/default sandbox arm/);
    const built = buildSandboxAb(
      arm(false, runsFor({ 'chrome-cdp-ex': [120, 100], '@playwright/cli': [140, 120], 'chrome-devtools-mcp': [160, 150] })),
      arm(true, runsFor({ 'chrome-cdp-ex': [110, 100], '@playwright/cli': [130, 120], 'chrome-devtools-mcp': [155, 150] })),
    );
    expect(built.replacesHeadline).toBe(false);
    expect(built.conclusion.verdict).toBe('offset-absent');
    expect(built.conclusion.text).not.toContain('unexplained');
    const withLoad = (noSandbox, runs, one) => ({
      ...arm(noSandbox, runs),
      environment: {
        ...arm(noSandbox, runs).environment,
        loadAvg: { start: { one, five: 0.1, fifteen: 0.1 }, end: { one, five: 0.1, fifteen: 0.1 } },
      },
    });
    const kept = buildSandboxAb(
      withLoad(false, runsFor({ 'chrome-cdp-ex': [873, 100], '@playwright/cli': [700, 120], 'chrome-devtools-mcp': [160, 150] }), 0.18),
      withLoad(true, runsFor({ 'chrome-cdp-ex': [609, 100], '@playwright/cli': [690, 120], 'chrome-devtools-mcp': [155, 150] }), 0.88),
    );
    expect(kept.conclusion.verdict).toBe('inconclusive');
    expect(kept.conclusion.text).toContain('fell from 773 ms to 509 ms');
    expect(kept.conclusion.text).toContain('about 264 ms');
    expect(kept.conclusion.text).toContain('1-minute 0.88 vs 0.18');
    expect(kept.conclusion.text).toContain('n=1 scored runs per tool per task');
    const board = renderSlice1Board({
      date: '2026-10-08',
      measuredAt: '2026-10-08T00:00:00.000Z',
      environment: { os: 'test', node: 'v22', chrome: 'Chrome', noSandbox: false },
      viewport: { width: 1042, height: 632, readback: '1042x632' },
      runsPerTool: 3,
      tokenEstimator: 'chars/4',
      tools: [],
      protocol: 'protocol text',
      rows: built.arms[0].rows,
      losses: [],
      rerun: 'npm run benchmark:slice1',
      sandboxAb: { ...built, rerun: 'npm run benchmark:slice1 -- --sandbox-ab' },
    });
    expect(board).toContain('## Sandbox A/B');
    expect(board).toContain('SLICE1_NO_SANDBOX=1');
    expect(board).toContain('does not reproduce the offset');
    expect(board).toContain(built.conclusion.text);
    expect(board).not.toContain('this VM');
  });
});

describe('slice1 fixtures', () => {
  it('builds the five local pages with stable markers', () => {
    expect(fixtureHtml('overlay')).toContain('SLICE1_DIALOG_BODY');
    expect(fixtureHtml('overlay')).toContain('UNDERPAGE_CLEAR_MARKER');
    expect(fixtureHtml('covered')).toContain('Submit transfer');
    expect(fixtureHtml('covered')).toContain('id="cover"');
    expect(fixtureHtml('dense')).toContain('Control 01');
    expect(fixtureHtml('dense')).toContain('Control 40');
    expect(fixtureHtml('stale')).toContain('__slice1Rewrite');
    expect(fixtureHtml('session')).toContain('slice1_session=already-set');
  });
});
