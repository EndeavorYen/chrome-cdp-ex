import { describe, expect, it, vi } from 'vitest';

import {
  __test__ as cdpTest,
  executeCdpCli,
} from '../skills/chrome-cdp-ex/scripts/cdp.mjs';
import { createMcpRequestHandler } from '../skills/chrome-cdp-ex/scripts/mcp-server.mjs';
import { createRuntimeClient } from '../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs';

const FAILED_ACTION = {
  schema: 'chrome-cdp-ex.action.v1',
  action: 'nav',
  target: {
    targetId: 'ABC12345',
    input: 'https://example.com/',
    resolvedBy: 'url',
    label: 'https://example.com/',
  },
  dispatch: {
    ok: false,
    method: 'nav',
    error: 'Timeout: Page.navigate',
  },
  settle: { ok: false, durationMs: 15007 },
  effects: {
    domDiff: null,
    console: [],
    network: [],
    navigation: null,
    failure: {
      kind: 'timeout',
      reason: 'The action timed out before dispatch completed.',
      nextCommand: 'cdp status ABC12345',
      originalMessage: 'Timeout: Page.navigate',
    },
  },
  outcome: {
    status: 'failed',
    changed: false,
    needsAttention: true,
  },
  verdict: {
    status: 'blocked',
    canContinue: false,
    needsRecovery: true,
    primaryNextStep: 'cdp status ABC12345',
    nextSteps: ['cdp status ABC12345'],
  },
  receipt: {
    schema: 'chrome-cdp-ex.action-receipt.v1',
    eventId: 'fixture-event',
    sequence: 1,
    dispatch: { ok: false, method: 'nav' },
    settlement: { state: 'failed', strategy: 'full-perceive', durationMs: 15007, signals: ['dispatch-error'] },
    outcome: 'failed',
    blockingSignals: ['dispatch-error'],
    recoveryHint: 'cdp status ABC12345',
    nextSteps: ['cdp status ABC12345'],
  },
  nextSteps: ['cdp status ABC12345'],
};

const FAILED_ACTION_JSON = JSON.stringify(FAILED_ACTION, null, 2);

function runMainWithStdout(stdout) {
  return async ({ console }) => {
    console.log(stdout);
  };
}

function replayArtifact(actions) {
  return {
    schema: 'chrome-cdp-ex.record-actions.v1',
    targetId: 'ABC12345',
    sessionId: 'fixture-session',
    actions,
  };
}

describe('hard action dispatch exit contract (#143)', () => {
  it('preserves the complete JSON Action Result while in-process CLI execution returns non-zero', async () => {
    const result = await executeCdpCli(
      ['nav', 'ABC12345', 'https://example.com/', '--format', 'json'],
      { runMain: runMainWithStdout(FAILED_ACTION_JSON) },
    );

    expect(result).toEqual({
      code: 1,
      stdout: FAILED_ACTION_JSON,
      stderr: '',
    });
    expect(JSON.parse(result.stdout).receipt).toEqual(FAILED_ACTION.receipt);
  });

  it('maps the same in-process CLI result to MCP isError without losing the Action Result text', async () => {
    const sent = [];
    const runtimeClient = createRuntimeClient({
      executeCli: command => executeCdpCli(command, {
        runMain: runMainWithStdout(FAILED_ACTION_JSON),
      }),
    });
    const handle = createMcpRequestHandler({
      runtimeClient,
      sendMessage: message => sent.push(message),
    });

    await handle({
      jsonrpc: '2.0',
      id: 143,
      method: 'tools/call',
      params: {
        name: 'run_command',
        arguments: {
          command: 'nav',
          args: ['ABC12345', 'https://example.com/', '--format', 'json'],
          confirm: true,
        },
      },
    });

    expect(sent).toEqual([{
      jsonrpc: '2.0',
      id: 143,
      result: {
        content: [{ type: 'text', text: FAILED_ACTION_JSON }],
        isError: true,
      },
    }]);
  });

  it.each([
    ['post-dispatch observation timeout', {
      dispatch: { ok: true, method: 'click' },
      settle: { ok: false, durationMs: 15000 },
      outcome: { status: 'timeout' },
      verdict: { status: 'verify', canContinue: false, needsRecovery: true },
    }],
    ['no-change verdict', {
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      outcome: { status: 'no-change' },
      verdict: { status: 'investigate', canContinue: false, needsRecovery: true },
    }],
    ['attention verdict', {
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 50 },
      outcome: { status: 'attention' },
      verdict: { status: 'recover', canContinue: false, needsRecovery: true },
    }],
  ])('keeps %s as successful transport when dispatch completed', async (_label, state) => {
    const output = JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1',
      action: 'click',
      target: { targetId: 'ABC12345' },
      ...state,
    });

    await expect(executeCdpCli(
      ['click', 'ABC12345', '#fixture', '--format', 'json'],
      { runMain: runMainWithStdout(output) },
    )).resolves.toEqual({ code: 0, stdout: output, stderr: '' });
  });

  it('makes replay halt when a nested JSON action says dispatch failed', async () => {
    const run = vi.fn(async () => ({ ok: true, result: FAILED_ACTION_JSON }));
    const artifact = replayArtifact([
      { action: 'nav', command: ['nav', 'https://example.com/'], replayable: true, needsInput: [] },
      { action: 'click', command: ['click', '#later'], replayable: true, needsInput: [] },
    ]);

    const output = await cdpTest.replayActionsStr(
      { run },
      ['--format', 'json', '--json', JSON.stringify(artifact)],
    );
    const model = JSON.parse(output);

    expect(run).toHaveBeenCalledTimes(1);
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.replay.v1',
      halted: true,
      counts: { actions: 2, ok: 0, failed: 1, skipped: 0 },
      failedStep: {
        phase: 'action',
        index: 1,
        command: ['nav', 'https://example.com/'],
        ok: false,
        error: 'Timeout: Page.navigate',
      },
    });
  });

  it('makes repeat fail fast when a nested JSON action says dispatch failed', async () => {
    const run = vi.fn(async () => ({ ok: true, result: FAILED_ACTION_JSON }));

    await expect(cdpTest.repeatStr({ run }, ['2', 'nav', 'https://example.com/']))
      .rejects.toThrow(/Timeout: Page\.navigate.*Repeat halted at iteration 1\/2/s);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
