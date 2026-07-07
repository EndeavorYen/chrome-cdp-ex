import { describe, expect, it } from 'vitest';

import {
  encodeMcpFrame,
  formatMcpBenchmarkReport,
  parseMcpFrames,
  summarizeMcpBenchmarkRun,
} from '../scripts/benchmark-mcp-path.mjs';

describe('benchmark MCP path helpers', () => {
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
});
