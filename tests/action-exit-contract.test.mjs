import { describe, expect, it, vi } from 'vitest';

import {
  __test__ as cdpTest,
  executeCdpCli,
} from '../skills/chrome-cdp-ex/scripts/cdp.mjs';
import { createMcpRequestHandler } from '../skills/chrome-cdp-ex/scripts/mcp-server.mjs';
import { createRuntimeClient } from '../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs';
import {
  commandResult,
  createCommandRegistry,
} from '../skills/chrome-cdp-ex/scripts/lib/command-application.mjs';
import { createCommandDispatcher } from '../skills/chrome-cdp-ex/scripts/lib/command-dispatch.mjs';

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

const FAILED_CLICK_ACTION = {
  ...FAILED_ACTION,
  action: 'click',
  target: {
    targetId: 'ABC12345',
    input: '#save',
    resolvedBy: 'selector-or-ref',
    label: '#save',
  },
  dispatch: {
    ok: false,
    method: 'click',
    error: 'Element not found: #save',
  },
  effects: {
    ...FAILED_ACTION.effects,
    failure: {
      ...FAILED_ACTION.effects.failure,
      originalMessage: 'Element not found: #save',
    },
  },
};

function semanticInteraction(actionResult, { textMatched = false } = {}) {
  return cdpTest.buildSemanticInteractionModel(actionResult, {
    selector: '#save',
    expectText: 'Saved',
    evidence: 'concise',
  }, { textMatched });
}

function qaPageWith(action) {
  return cdpTest.buildQaPageModel({
    targetId: 'ABC12345',
    page: { title: 'Fixture', url: 'https://example.com/' },
    pageHealth: { status: 'populated', isBlank: false },
    console: { errors: 0, warnings: 0, exceptions: 0 },
    perception: { captured: true, summary: 'Fixture' },
    screenshots: {},
    action,
    assertions: [],
    errors: [],
  });
}

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
  it('makes the daemon application route additive-fail while preserving the Action Result bytes', async () => {
    const registry = createCommandRegistry([{
      name: 'nav',
      aliases: [],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'full-perceive',
      outputFormats: ['text', 'json'],
      kind: 'mutation',
      authorization: 'mutation',
      evidencePolicy: 'action-receipt',
    }]);
    const dispatcher = createCommandDispatcher({
      registry,
      owners: { nav: 'application' },
      handlers: {
        nav: async () => commandResult(FAILED_ACTION_JSON, { kind: 'action-receipt' }),
      },
      authorize: () => ({ allowed: true, code: 'fixture' }),
    });

    await expect(cdpTest.executeDaemonApplicationRoute({
      cmd: 'nav',
      args: ['https://example.com/', '--format', 'json'],
      targetBound: true,
    }, dispatcher)).resolves.toEqual({
      handled: true,
      ok: false,
      result: FAILED_ACTION_JSON,
      error: 'Timeout: Page.navigate',
    });
  });

  it('writes additive daemon failures to CLI stdout and reserves stderr for ordinary errors', () => {
    const stdout = [];
    const stderr = [];
    const processLike = { exitCode: 0, platform: 'darwin' };
    const consoleLike = {
      log: value => stdout.push(value),
      error: value => stderr.push(value),
    };

    cdpTest.emitTargetCommandResponse?.({
      ok: false,
      result: FAILED_ACTION_JSON,
      error: 'Timeout: Page.navigate',
    }, {
      cmd: 'nav',
      targetPrefix: 'ABC12345',
      format: 'json',
      targetResolution: null,
      console: consoleLike,
      process: processLike,
    });

    expect({ stdout, stderr, exitCode: processLike.exitCode }).toEqual({
      stdout: [FAILED_ACTION_JSON],
      stderr: [],
      exitCode: 1,
    });

    stdout.length = 0;
    stderr.length = 0;
    processLike.exitCode = 0;
    cdpTest.emitTargetCommandResponse({
      ok: false,
      error: 'Element not found: #missing',
    }, {
      cmd: 'click',
      targetPrefix: 'ABC12345',
      format: 'text',
      console: consoleLike,
      process: processLike,
    });
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('Element not found: #missing');
    expect(processLike.exitCode).toBe(1);
  });

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

  it('returns non-zero for documented verify-click JSON when click dispatch failed', async () => {
    const model = semanticInteraction(FAILED_CLICK_ACTION);
    const output = JSON.stringify(model, null, 2);

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.semantic-interaction.v1',
      action: 'click',
      dispatch: { ok: false, error: 'Element not found: #save' },
      verdict: 'fail',
      actionEvidence: null,
    });
    await expect(executeCdpCli(
      ['verify-click', 'ABC12345', '#save', '--expect-text', 'Saved', '--format', 'json'],
      {
        runMain: async ({ console }) => {
          console.log(cdpTest.formatActionWorkflowCommandOutput(model, { format: 'json' }));
        },
      },
    )).resolves.toEqual({ code: 1, stdout: output, stderr: '' });
  });

  it('returns non-zero for documented qa --click JSON when nested click dispatch failed', async () => {
    const action = semanticInteraction(FAILED_CLICK_ACTION);
    const model = qaPageWith(action);
    const output = JSON.stringify(model, null, 2);

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.qa-page.v1',
      action: {
        schema: 'chrome-cdp-ex.semantic-interaction.v1',
        action: 'click',
        dispatch: { ok: false, error: 'Element not found: #save' },
        verdict: 'fail',
      },
      verdict: 'fail',
    });
    await expect(executeCdpCli(
      ['qa', 'ABC12345', '--click', '#save', '--expect-text', 'Saved', '--format', 'json'],
      {
        runMain: async ({ console }) => {
          console.log(cdpTest.formatActionWorkflowCommandOutput(model, { format: 'json' }));
        },
      },
    )).resolves.toEqual({ code: 1, stdout: output, stderr: '' });
  });

  it.each([
    ['verify-click', model => model, ['verify-click', 'ABC12345', '#save', '--expect-text', 'Saved']],
    ['qa --click', qaPageWith, ['qa', 'ABC12345', '--click', '#save', '--expect-text', 'Saved']],
  ])('returns non-zero for documented %s text when click dispatch failed', async (_label, wrap, command) => {
    const model = wrap(semanticInteraction(FAILED_CLICK_ACTION));

    const result = await executeCdpCli(command, {
      runMain: async ({ console }) => {
        console.log(cdpTest.formatActionWorkflowCommandOutput(model, {
          format: 'text',
          text: () => model.schema === 'chrome-cdp-ex.qa-page.v1'
            ? cdpTest.formatQaPageReport(model)
            : cdpTest.formatSemanticInteractionResult(model),
        }));
      },
    });

    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain('Element not found: #save');
  });

  it.each([
    ['verify-click assertion failure', model => model, [
      'verify-click', 'ABC12345', '#save', '--expect-text', 'Saved', '--format', 'json',
    ]],
    ['qa --click assertion failure', qaPageWith, [
      'qa', 'ABC12345', '--click', '#save', '--expect-text', 'Saved', '--format', 'json',
    ]],
  ])('keeps %s as transport success when click dispatch succeeded', async (_label, wrap, command) => {
    const dispatched = {
      ...FAILED_CLICK_ACTION,
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
      outcome: { status: 'no-change', changed: false, needsAttention: true },
      verdict: { status: 'investigate', canContinue: false, needsRecovery: true },
    };
    const interaction = semanticInteraction(dispatched, { textMatched: false });
    const model = wrap(interaction);
    const output = JSON.stringify(model, null, 2);

    expect(interaction).toMatchObject({ dispatch: { ok: true }, verdict: 'fail' });
    await expect(executeCdpCli(command, {
      runMain: async ({ console }) => {
        console.log(cdpTest.formatActionWorkflowCommandOutput(model, { format: 'json' }));
      },
    })).resolves.toEqual({ code: 0, stdout: output, stderr: '' });
  });

  it.each([
    ['verify-click', model => model, ['verify-click', 'ABC12345', '#save', '--expect-text', 'Saved']],
    ['qa --click', qaPageWith, ['qa', 'ABC12345', '--click', '#save', '--expect-text', 'Saved']],
  ])('keeps %s text assertion failure as transport success after dispatch', async (_label, wrap, command) => {
    const dispatched = {
      ...FAILED_CLICK_ACTION,
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
      outcome: { status: 'no-change', changed: false, needsAttention: true },
      verdict: { status: 'investigate', canContinue: false, needsRecovery: true },
    };
    const model = wrap(semanticInteraction(dispatched, { textMatched: false }));
    const text = model.schema === 'chrome-cdp-ex.qa-page.v1'
      ? cdpTest.formatQaPageReport(model)
      : cdpTest.formatSemanticInteractionResult(model);

    await expect(executeCdpCli(command, {
      runMain: async ({ console }) => {
        console.log(cdpTest.formatActionWorkflowCommandOutput(model, {
          format: 'text',
          text: () => text,
        }));
      },
    })).resolves.toEqual({ code: 0, stdout: text, stderr: '' });
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

  it('keeps failed Action Result evidence when flow receives the additive daemon response', async () => {
    const output = await cdpTest.flowStr({
      run: async () => ({
        ok: false,
        result: FAILED_ACTION_JSON,
        error: 'Timeout: Page.navigate',
      }),
      settle: async () => '',
    }, 'nav https://example.com/; summary', {
      format: 'json',
      targetId: 'ABC12345',
    });
    const model = JSON.parse(output);

    expect(model.failedStep).toMatchObject({
      ok: false,
      error: 'Timeout: Page.navigate',
      failureKind: 'timeout',
      verdict: {
        status: 'blocked',
        canContinue: false,
        needsRecovery: true,
        primaryNextStep: 'cdp status ABC12345',
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
