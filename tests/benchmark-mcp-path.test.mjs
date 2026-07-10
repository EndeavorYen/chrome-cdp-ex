import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';

import {
  encodeMcpFrame,
  formatMcpBenchmarkReport,
  parseMcpFrames,
  PROBLEM_FINDING_TASK_ID,
  runCliProcess,
  summarizeCliBenchmarkRun,
  summarizeMcpBenchmarkRun,
} from '../scripts/benchmark-mcp-path.mjs';

describe('benchmark MCP path helpers', () => {
  it('keeps the parent event loop responsive while a CLI child uses its fixture server', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('fixture-ready');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/`;

    try {
      const result = await runCliProcess(process.execPath, [
        '-e',
        "fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e);process.exit(1)})",
        url,
      ], { timeout: 5000 });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('fixture-ready');
      expect(result.stderr).toBe('');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('encodes and parses content-length framed MCP messages', () => {
    const frame = Buffer.from(
      encodeMcpFrame({ jsonrpc: '2.0', id: 1, result: { ok: true, text: '戰鬥勝利' } }),
      'utf8',
    );

    const parsed = parseMcpFrames(frame);

    expect(parsed.rest.length).toBe(0);
    expect(parsed.messages).toEqual([
      { jsonrpc: '2.0', id: 1, result: { ok: true, text: '戰鬥勝利' } },
    ]);
  });

  it('summarizes the MCP problem-finding path and gates recovery coverage', () => {
    const startedAt = 1000;
    const step = (name, mcpTool, offset, durationMs, model, extra = {}) => ({
      name,
      mcpTool,
      command: extra.command || [name],
      startedAt: startedAt + offset,
      endedAt: startedAt + offset + durationMs,
      status: 0,
      stdout: JSON.stringify(model),
      stderr: '',
      ...extra,
    });
    const steps = [
      {
        name: 'initialize',
        mcpMethod: 'initialize',
        command: ['mcp', 'initialize'],
        startedAt,
        endedAt: startedAt + 5,
        status: 0,
        stdout: '{}',
        stderr: '',
        benchmarkProbe: true,
      },
      {
        name: 'tools-list',
        mcpMethod: 'tools/list',
        command: ['mcp', 'tools/list'],
        startedAt: startedAt + 5,
        endedAt: startedAt + 10,
        status: 0,
        stdout: JSON.stringify({
          tools: [
            { name: 'controls' },
            { name: 'overlay' },
            { name: 'dismiss_modal' },
            { name: 'verify_click' },
          ],
        }),
        stderr: '',
        benchmarkProbe: true,
      },
      step('open', 'open_or_attach', 20, 100, { schema: 'chrome-cdp-ex.open.v1', targetPrefix: 'AABBCCDD' }),
      step('controls', 'controls', 130, 40, { schema: 'chrome-cdp-ex.visible-controls.v1', controls: [{ ref: '@1' }] }),
      step('overlay', 'overlay', 180, 30, {
        schema: 'chrome-cdp-ex.overlays.v1',
        blocking: true,
        nextCommand: 'cdp dismiss-modal AABBCCDD',
      }),
      step('dismiss-modal', 'dismiss_modal', 220, 300, {
        schema: 'chrome-cdp-ex.action.v1',
        dispatch: { ok: true },
      }),
      step('verify-click', 'verify_click', 540, 400, {
        schema: 'chrome-cdp-ex.semantic-interaction.v1',
        verdict: 'pass',
        action: { verdict: 'continue' },
        assertions: [{ kind: 'text', status: 'pass' }],
      }),
      step('report', 'report', 960, 40, {
        schema: 'chrome-cdp-ex.report.v1',
        actions: [{ action: 'dismiss-modal' }, { action: 'click' }],
      }),
    ];

    const summary = summarizeMcpBenchmarkRun({
      startedAt,
      endedAt: startedAt + 1010,
      target: 'AABBCCDD',
      steps,
    });

    expect(summary.metrics.toolCalls).toBe(6);
    expect(summary.metrics.protocolCalls).toBe(2);
    expect(summary.metrics.overlayRecoveryCovered).toBe(true);
    expect(summary.metrics.semanticVerificationPassed).toBe(true);
    expect(summary.metrics.reportTimeline).toBe(true);
    expect(summary.gate).toMatchObject({ passed: true, passedCount: 11, total: 11 });
    expect(formatMcpBenchmarkReport(summary)).toContain('Quality gate: pass');
  });

  it('fails when one MCP tool dominates output before the total token budget is exhausted', () => {
    const startedAt = 0;
    const hugeReport = 'x'.repeat(14000);
    const steps = [
      {
        name: 'tools-list',
        mcpMethod: 'tools/list',
        command: ['mcp', 'tools/list'],
        startedAt,
        endedAt: 5,
        status: 0,
        stdout: JSON.stringify({
          tools: [
            { name: 'controls' },
            { name: 'overlay' },
            { name: 'dismiss_modal' },
            { name: 'verify_click' },
          ],
        }),
        stderr: '',
        benchmarkProbe: true,
      },
      {
        name: 'open',
        mcpTool: 'open_or_attach',
        command: ['open'],
        startedAt: 10,
        endedAt: 20,
        status: 0,
        stdout: JSON.stringify({ schema: 'chrome-cdp-ex.open.v1', targetPrefix: 'AABBCCDD' }),
        stderr: '',
      },
      {
        name: 'controls',
        mcpTool: 'controls',
        command: ['controls'],
        startedAt: 20,
        endedAt: 30,
        status: 0,
        stdout: JSON.stringify({ schema: 'chrome-cdp-ex.visible-controls.v1', controls: [{ ref: '@1' }] }),
        stderr: '',
      },
      {
        name: 'overlay',
        mcpTool: 'overlay',
        command: ['overlay'],
        startedAt: 30,
        endedAt: 40,
        status: 0,
        stdout: JSON.stringify({ schema: 'chrome-cdp-ex.overlays.v1', blocking: true, nextCommand: 'cdp dismiss-modal AABBCCDD' }),
        stderr: '',
      },
      {
        name: 'dismiss-modal',
        mcpTool: 'dismiss_modal',
        command: ['dismiss-modal'],
        startedAt: 40,
        endedAt: 50,
        status: 0,
        stdout: JSON.stringify({ schema: 'chrome-cdp-ex.action.v1', dispatch: { ok: true } }),
        stderr: '',
      },
      {
        name: 'verify-click',
        mcpTool: 'verify_click',
        command: ['verify-click'],
        startedAt: 50,
        endedAt: 60,
        status: 0,
        stdout: JSON.stringify({
          schema: 'chrome-cdp-ex.semantic-interaction.v1',
          verdict: 'pass',
          action: { verdict: 'continue' },
          assertions: [{ kind: 'text', status: 'pass' }],
        }),
        stderr: '',
      },
      {
        name: 'report',
        mcpTool: 'report',
        command: ['report'],
        startedAt: 60,
        endedAt: 70,
        status: 0,
        stdout: JSON.stringify({
          schema: 'chrome-cdp-ex.report.v1',
          actions: [{ action: 'click' }],
          payload: hugeReport,
        }),
        stderr: '',
      },
    ];

    const summary = summarizeMcpBenchmarkRun({
      startedAt,
      endedAt: 80,
      target: 'AABBCCDD',
      steps,
    });

    expect(summary.metrics.estimatedOutputTokens).toBeLessThan(12000);
    expect(summary.metrics.maxToolOutputTokens).toBeGreaterThan(3200);
    expect(summary.metrics.perToolOutputTokens).toContainEqual(expect.objectContaining({
      tool: 'report',
      estimatedTokens: summary.metrics.maxToolOutputTokens,
    }));
    expect(summary.gate.criteria).toContainEqual(expect.objectContaining({
      name: 'mcp-tool-output-budget',
      passed: false,
      actual: summary.metrics.maxToolOutputTokens,
      limit: '<= 3200 tokens/tool',
    }));
    expect(formatMcpBenchmarkReport(summary)).toContain('Biggest tool output: report');
  });

  it('summarizes a matched CLI route with the same task and semantic checkpoints', () => {
    const startedAt = 1000;
    const step = (name, offset, model) => ({
      name,
      command: [name],
      startedAt: startedAt + offset,
      endedAt: startedAt + offset + 20,
      status: 0,
      stdout: JSON.stringify(model),
      stderr: '',
    });
    const steps = [
      step('open', 0, { schema: 'chrome-cdp-ex.open.v1', targetPrefix: 'AABBCCDD' }),
      step('controls', 30, { schema: 'chrome-cdp-ex.visible-controls.v1', controls: [{ selector: '#combat' }] }),
      step('overlay', 60, { schema: 'chrome-cdp-ex.overlays.v1', blocking: true, nextCommand: 'cdp dismiss-modal AABBCCDD' }),
      step('dismiss-modal', 90, { schema: 'chrome-cdp-ex.action.v1', dispatch: { ok: true } }),
      step('verify-click', 120, {
        schema: 'chrome-cdp-ex.semantic-interaction.v1',
        verdict: 'pass',
        action: { verdict: 'continue' },
        assertions: [{ kind: 'text', status: 'pass' }],
      }),
      step('report', 150, { schema: 'chrome-cdp-ex.report.v1', actions: [{ action: 'click' }] }),
    ];

    const summary = summarizeCliBenchmarkRun({
      startedAt,
      endedAt: startedAt + 180,
      target: 'AABBCCDD',
      steps,
    });

    expect(summary).toMatchObject({
      schema: 'chrome-cdp-ex.cli-benchmark.v1',
      taskId: PROBLEM_FINDING_TASK_ID,
      success: true,
      metrics: {
        commandCalls: 6,
        overlayRecoveryCovered: true,
        semanticVerificationPassed: true,
        reportTimeline: true,
      },
      gate: { passed: true },
    });
    expect(summary.semanticCheckpoints).toEqual([
      'open',
      'controls',
      'overlay',
      'dismiss-modal',
      'verify-click',
      'report',
    ]);
  });
});
