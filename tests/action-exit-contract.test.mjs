import { EventEmitter } from 'events';
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

function semanticInteraction(actionResult, { textMatched = false, evidence = 'concise' } = {}) {
  return cdpTest.buildSemanticInteractionModel(actionResult, {
    selector: '#save',
    expectText: 'Saved',
    evidence,
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

async function detachedRefActionFixture({ input = '@1', frameRef = null } = {}) {
  const refMap = frameRef ? new Map() : new Map([[1, 14801]]);
  const refState = {
    generation: 1,
    invalidationReason: null,
    ...(frameRef ? {
      frameRefs: new Map([[frameRef, {
        frameRef,
        frameId: 'child-frame',
        parentId: null,
        refs: new Map([[1, 14801]]),
      }]]),
    } : {}),
  };
  const inputCalls = [];
  const observe = vi.fn(async () => '+++ Added\n+ [button] pre-action remount');
  const cdp = {
    calls: [],
    async send(method, params = {}, sessionId) {
      this.calls.push({ method, params, sessionId });
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'root-frame' } } };
      }
      if (method === 'Page.createIsolatedWorld') {
        return { executionContextId: 901 };
      }
      if (method === 'DOM.resolveNode') {
        return {
          object: {
            objectId: params.executionContextId === 901
              ? 'isolated-detached-ref'
              : 'page-detached-ref',
          },
        };
      }
      if (method === 'Runtime.callFunctionOn') {
        if (params.objectId === 'isolated-detached-ref') {
          return { result: { value: { connected: false } } };
        }
        return { result: { value: {
          connected: true,
          x: 10,
          y: 20,
          w: 100,
          h: 30,
          tag: 'BUTTON',
          text: 'Forged Alpha',
        } } };
      }
      if (method.startsWith('Input.dispatch')) {
        inputCalls.push({ method, params });
        return {};
      }
      return {};
    },
  };
  let captured = null;
  const output = await cdpTest.runActionWithFeedback({
    action: 'click',
    target: {
      targetId: 'ABC12345',
      input,
      resolvedBy: 'selector-or-ref',
      label: input,
    },
    dispatch: () => cdpTest.clickStr(cdp, 'sid', input, refMap, refState),
    feedbackPolicy: 'settle-diff',
    observe,
    onActionResult: result => { captured = result; },
    format: 'json',
  });
  return { output, captured, cdp, refMap, refState, inputCalls, observe };
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

  describe('concise workflow wrappers', () => {
    it.each([
      ['verify-click', semanticInteraction(FAILED_CLICK_ACTION)],
      ['qa', qaPageWith(semanticInteraction(FAILED_CLICK_ACTION))],
    ])('returns a failed batch step instead of crashing for concise %s evidence', (cmd, wrapper) => {
      const output = cdpTest.formatBatchResults([{
        cmd,
        ok: true,
        result: JSON.stringify(wrapper),
      }], 'model', { targetId: 'ABC12345' });

      expect(JSON.parse(output)).toMatchObject({
        counts: { steps: 1, ok: 0, failed: 1 },
        failedStep: {
          cmd,
          ok: false,
          error: 'Element not found: #save',
        },
        nextSteps: ['cdp status ABC12345'],
      });
    });

    it.each([
      ['verifyclick', semanticInteraction(FAILED_CLICK_ACTION)],
      ['qa-page', qaPageWith(semanticInteraction(FAILED_CLICK_ACTION))],
    ])('halts flow without crashing for concise %s alias evidence', async (cmd, wrapper) => {
      const output = await cdpTest.flowStr({
        run: async () => ({ ok: true, result: JSON.stringify(wrapper) }),
        settle: async () => '',
      }, `${cmd} #save; summary`, { format: 'json', targetId: 'ABC12345' });

      expect(JSON.parse(output)).toMatchObject({
        halted: true,
        counts: { steps: 2, ok: 0, failed: 1, skipped: 1 },
        failedStep: {
          cmd,
          ok: false,
          error: 'Element not found: #save',
        },
        nextSteps: ['cdp status ABC12345'],
      });
    });

    it('preserves detailed recovery when full semantic action evidence exists', () => {
      const wrapper = semanticInteraction(FAILED_ACTION, { evidence: 'full' });
      const output = cdpTest.formatBatchResults([{
        cmd: 'verifyclick',
        ok: true,
        result: JSON.stringify(wrapper),
      }], 'model', { targetId: 'ABC12345' });

      expect(JSON.parse(output).failedStep).toMatchObject({
        cmd: 'verifyclick',
        ok: false,
        error: 'Timeout: Page.navigate',
        failureKind: 'timeout',
        nextCommand: 'cdp status ABC12345',
        verdict: {
          status: 'blocked',
          canContinue: false,
          needsRecovery: true,
        },
      });
    });
  });

  describe('command-authorized semantic classification', () => {
    const PAGE_ACTION_JSON = JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1',
      dispatch: { ok: false, error: 'page data, not a command receipt' },
    });
    const PAGE_SEMANTIC_JSON = JSON.stringify({
      schema: 'chrome-cdp-ex.semantic-interaction.v1',
      dispatch: { ok: false, error: 'page semantic data' },
      actionEvidence: null,
    });
    const PAGE_QA_JSON = JSON.stringify({
      schema: 'chrome-cdp-ex.qa-page.v1',
      action: JSON.parse(PAGE_SEMANTIC_JSON),
    });

    it.each([
      ['text', ['text', 'ABC12345'], PAGE_ACTION_JSON],
      ['eval', ['eval', 'ABC12345', 'document.body.innerText'], PAGE_SEMANTIC_JSON],
      ['text with nested QA data', ['text', 'ABC12345', 'pre'], PAGE_QA_JSON],
    ])('keeps %s CLI page output successful when it resembles action evidence', async (_label, command, output) => {
      await expect(executeCdpCli(command, {
        runMain: runMainWithStdout(output),
      })).resolves.toEqual({ code: 0, stdout: output, stderr: '' });
    });

    it('keeps daemon read output successful when it resembles an Action Result', async () => {
      const registry = createCommandRegistry([{
        name: 'text',
        aliases: [],
        needsTarget: true,
        mutates: false,
        feedbackPolicy: null,
        outputFormats: ['text'],
        kind: 'read',
        authorization: 'standard',
        evidencePolicy: 'none',
      }]);
      const dispatcher = createCommandDispatcher({
        registry,
        owners: { text: 'application' },
        handlers: {
          text: async () => commandResult(PAGE_ACTION_JSON, null),
        },
        authorize: () => ({ allowed: true, code: 'fixture' }),
      });

      await expect(cdpTest.executeDaemonApplicationRoute({
        cmd: 'text',
        args: [],
        targetBound: true,
      }, dispatcher)).resolves.toEqual({
        handled: true,
        result: PAGE_ACTION_JSON,
      });
    });

    it('keeps the real CLI response emitter successful for action-shaped read output', () => {
      const stdout = [];
      const stderr = [];
      const processLike = { exitCode: 0, platform: 'darwin' };

      cdpTest.emitTargetCommandResponse({ ok: true, result: PAGE_ACTION_JSON }, {
        cmd: 'text',
        targetPrefix: 'ABC12345',
        format: 'text',
        console: {
          log: value => stdout.push(value),
          error: value => stderr.push(value),
        },
        process: processLike,
      });

      expect({ stdout, stderr, exitCode: processLike.exitCode }).toEqual({
        stdout: [PAGE_ACTION_JSON],
        stderr: [],
        exitCode: 0,
      });
    });

    it('keeps batch and flow read output successful when it resembles action evidence', async () => {
      const batch = JSON.parse(cdpTest.formatBatchResults([{
        cmd: 'text',
        ok: true,
        result: PAGE_ACTION_JSON,
      }], 'model', { targetId: 'ABC12345' }));
      const flow = JSON.parse(await cdpTest.flowStr({
        run: async () => ({ ok: true, result: PAGE_SEMANTIC_JSON }),
        settle: async () => '',
      }, 'eval document.body.innerText', { format: 'json', targetId: 'ABC12345' }));

      expect(batch).toMatchObject({
        counts: { ok: 1, failed: 0 },
        steps: [{ cmd: 'text', ok: true }],
      });
      expect(flow).toMatchObject({
        halted: false,
        counts: { ok: 1, failed: 0 },
        steps: [{ cmd: 'eval', ok: true }],
      });
    });

    it('keeps repeat and replay read output successful when it resembles action evidence', async () => {
      const repeated = await cdpTest.repeatStr({
        run: async () => ({ ok: true, result: PAGE_ACTION_JSON }),
      }, ['1', 'text', 'pre']);
      const artifact = replayArtifact([
        { action: 'read', command: ['text', 'pre'], replayable: true, needsInput: [] },
      ]);
      const replayed = JSON.parse(await cdpTest.replayActionsStr(
        { run: async () => ({ ok: true, result: PAGE_QA_JSON }) },
        ['--format', 'json', '--json', JSON.stringify(artifact)],
      ));

      expect(repeated).toContain('Done: 1 ok, 0 failed');
      expect(replayed).toMatchObject({
        halted: false,
        counts: { actions: 1, ok: 1, failed: 0 },
      });
    });

    it('still classifies an action alias as failed evidence', async () => {
      await expect(executeCdpCli(
        ['navigate', 'ABC12345', 'https://example.com/', '--format', 'json'],
        { runMain: runMainWithStdout(FAILED_ACTION_JSON) },
      )).resolves.toEqual({ code: 1, stdout: FAILED_ACTION_JSON, stderr: '' });
    });
  });
});

describe('ambiguous action completion contract (#150)', () => {
  async function committedActionDisconnect() {
    let mutations = 0;
    const connection = new EventEmitter();
    connection.write = vi.fn(payload => {
      expect(JSON.parse(payload)).toEqual({ cmd: 'click', args: ['#purchase'], id: 1 });
      mutations += 1;
      queueMicrotask(() => connection.emit('close'));
    });
    connection.end = vi.fn();
    connection.destroy = vi.fn();
    const error = await cdpTest.sendCommand(
      connection,
      { cmd: 'click', args: ['#purchase'] },
    ).catch(cause => cause);
    return { error, mutations, connection };
  }

  it('uses the trusted command policy for direct, protected, conditional, composite, and raw routes', () => {
    for (const command of ['click', 'loadall', 'console', 'batch', 'eval', 'evalraw']) {
      expect(cdpTest.daemonRequestMayHaveSideEffects({ cmd: command }), command).toBe(true);
    }
    for (const command of ['perceive', 'report', 'meta', 'list_raw']) {
      expect(cdpTest.daemonRequestMayHaveSideEffects({ cmd: command }), command).toBe(false);
    }
    expect(cdpTest.daemonRequestMayHaveSideEffects({ cmd: 'table', args: ['#grid'] })).toBe(false);
    expect(cdpTest.daemonRequestMayHaveSideEffects({
      cmd: 'table',
      args: ['--continue', 'ct1.0123456789abcdef0123456789abcdef.0', '--format', 'json'],
    })).toBe(false);
    expect(cdpTest.daemonRequestMayHaveSideEffects({
      cmd: 'table',
      args: ['#grid', '--collect', '--scroll-container', '.viewport'],
    })).toBe(true);
    expect(() => cdpTest.daemonRequestMayHaveSideEffects({ cmd: 'table', args: ['--collect'] }))
      .toThrow(/scroll-container/);
  });

  it.each([
    'connect ECONNREFUSED /fixture/runtime/cdp-ABC12345.sock',
    'connect ENOENT /fixture/runtime/cdp-ABC12345.sock',
    'connect ECONNRESET /fixture/runtime/cdp-ABC12345.sock',
    'Timed out connecting to daemon socket: /fixture/runtime/cdp-ABC12345.sock',
  ])('keeps a proven pre-dispatch disconnect restartable: %s', message => {
    const model = JSON.parse(cdpTest.formatCliError(new Error(message), {
      cmd: 'click',
      targetPrefix: 'ABC12345',
      format: 'json',
    }));

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.cli-error.v1',
      ok: false,
      recovery: {
        kind: 'daemon-disconnect',
        strategy: 'restart-tab-daemon',
        run: 'cdp perceive ABC12345 -C -d 8',
      },
      nextSteps: ['cdp perceive ABC12345 -C -d 8'],
    });
    expect(model).not.toHaveProperty('completion');
    expect(model).not.toHaveProperty('sideEffectMayHaveOccurred');
    expect(model).not.toHaveProperty('retrySafe');
  });

  it('returns verify-before-retry JSON after a mutation commits but its receipt is lost', async () => {
    const fixture = await committedActionDisconnect();
    const output = cdpTest.formatCliError(fixture.error, {
      cmd: 'click',
      targetPrefix: 'ABC12345',
      format: 'json',
    });
    const model = JSON.parse(output);

    expect(fixture.mutations).toBe(1);
    expect(fixture.connection.write).toHaveBeenCalledOnce();
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.cli-error.v1',
      ok: false,
      command: 'click',
      targetPrefix: 'ABC12345',
      completion: 'unknown',
      sideEffectMayHaveOccurred: true,
      retrySafe: false,
      recovery: {
        kind: 'ambiguous-action-completion',
        strategy: 'verify-before-retry',
        run: 'cdp perceive ABC12345 -C -d 8',
        reason: expect.stringMatching(/may have occurred.*do not repeat/i),
      },
      diagnostics: {
        transport: {
          phase: 'awaiting-response',
          kind: 'peer-close',
          message: expect.stringContaining('Connection closed before response.'),
        },
      },
      nextSteps: ['cdp perceive ABC12345 -C -d 8'],
    });
    expect(output).not.toContain('#purchase');
    expect(model.diagnostics.transport.message.length).toBeLessThanOrEqual(512);
  });

  it('prints an explicit unsafe-to-retry warning in the default CLI text surface', async () => {
    const fixture = await committedActionDisconnect();
    const output = cdpTest.formatCliError(fixture.error, {
      cmd: 'click',
      targetPrefix: 'ABC12345',
    });

    expect(output).toContain('Completion: unknown');
    expect(output).toContain('Side effect may have occurred: yes');
    expect(output).toContain('Retry safe: no');
    expect(output).toContain('Kind: ambiguous-action-completion');
    expect(output).toContain('Strategy: verify-before-retry');
    expect(output).toContain('Run: cdp perceive ABC12345 -C -d 8');
    expect(output).toMatch(/do not repeat/i);
    expect(output).toContain('Transport: awaiting-response/peer-close');
    expect(fixture.mutations).toBe(1);
    expect(fixture.connection.write).toHaveBeenCalledOnce();
  });

  it('keeps CLI nonzero and MCP isError parity without redispatching the mutation', async () => {
    const fixture = await committedActionDisconnect();
    const output = cdpTest.formatCliError(fixture.error, {
      cmd: 'click',
      targetPrefix: 'ABC12345',
      format: 'json',
    });
    const direct = await executeCdpCli(
      ['click', 'ABC12345', '#purchase', '--format', 'json'],
      {
        runMain: async ({ console, process }) => {
          console.error(output);
          process.exitCode = 1;
        },
      },
    );
    const sent = [];
    const handle = createMcpRequestHandler({
      runtimeClient: createRuntimeClient({ executeCli: async () => direct }),
      sendMessage: message => sent.push(message),
    });

    await handle({
      jsonrpc: '2.0',
      id: 150,
      method: 'tools/call',
      params: {
        name: 'run_command',
        arguments: {
          command: 'click',
          args: ['ABC12345', '#purchase', '--format', 'json'],
          confirm: true,
        },
      },
    });

    expect(direct).toEqual({ code: 1, stdout: '', stderr: output });
    expect(sent).toEqual([{
      jsonrpc: '2.0',
      id: 150,
      result: {
        content: [{ type: 'text', text: output }],
        isError: true,
      },
    }]);
    expect(fixture.mutations).toBe(1);
    expect(fixture.connection.write).toHaveBeenCalledOnce();
  });
});

describe('detached ref propagation contract (#148)', () => {
  it('preserves the stale-ref Action Result through direct CLI and MCP failure surfaces', async () => {
    const fixture = await detachedRefActionFixture();
    const action = JSON.parse(fixture.output);

    expect(action).toMatchObject({
      action: 'click',
      target: { input: '@1' },
      dispatch: { ok: false, method: 'click' },
      effects: {
        domDiff: null,
        failure: {
          kind: 'stale-ref',
          nextCommand: 'cdp perceive ABC12345 -C -d 8',
        },
      },
      outcome: { status: 'failed', changed: false },
      receipt: {
        schema: 'chrome-cdp-ex.action-receipt.v1',
        dispatch: { ok: false, method: 'click' },
        settlement: {
          state: 'failed',
          strategy: 'dispatch-failed',
          signals: ['dispatch-failed'],
        },
        outcome: 'failed',
        blockingSignals: expect.arrayContaining(['stale-ref']),
        recoveryHint: expect.stringMatching(/no longer maps|recovery command/i),
      },
    });
    expect(fixture.inputCalls).toEqual([]);
    expect(fixture.observe).not.toHaveBeenCalled();
    expect(fixture.refMap.has(1)).toBe(false);
    expect(fixture.cdp.calls.some(call => (
      call.method.startsWith('Accessibility.')
      || call.method === 'Runtime.evaluate'
    ))).toBe(false);

    const direct = await executeCdpCli(
      ['click', 'ABC12345', '@1', '--format', 'json'],
      { runMain: runMainWithStdout(fixture.output) },
    );
    expect(direct).toEqual({ code: 1, stdout: fixture.output, stderr: '' });

    const sent = [];
    const handle = createMcpRequestHandler({
      runtimeClient: createRuntimeClient({ executeCli: async () => direct }),
      sendMessage: message => sent.push(message),
    });
    await handle({
      jsonrpc: '2.0',
      id: 148,
      method: 'tools/call',
      params: {
        name: 'run_command',
        arguments: {
          command: 'click',
          args: ['ABC12345', '@1', '--format', 'json'],
          confirm: true,
        },
      },
    });
    expect(sent).toEqual([{
      jsonrpc: '2.0',
      id: 148,
      result: {
        content: [{ type: 'text', text: fixture.output }],
        isError: true,
      },
    }]);
  });

  it('keeps batch aggregate-all while flow, replay, and repeat halt without remapping', async () => {
    const fixture = await detachedRefActionFixture();
    const stale = async () => ({ ok: true, result: fixture.output });

    const batchRun = vi.fn(async command => (
      command.args[0] === '@1' ? stale() : { ok: true, result: 'later command completed' }
    ));
    const batchResults = await cdpTest.runBatchCommands({ run: batchRun }, [
      { cmd: 'click', args: ['@1'] },
      { cmd: 'click', args: ['#later'] },
    ]);
    expect(batchRun).toHaveBeenCalledTimes(2);
    expect(batchRun.mock.calls).toEqual([
      [{ cmd: 'click', args: ['@1'] }],
      [{ cmd: 'click', args: ['#later'] }],
    ]);
    expect(batchResults).toHaveLength(2);
    expect(batchResults[1]).toMatchObject({
      cmd: 'click',
      ok: true,
      result: 'later command completed',
    });
    const batchModel = JSON.parse(cdpTest.formatBatchResults(batchResults, 'model', {
      targetId: 'ABC12345',
    }));
    expect(batchModel).toMatchObject({
      counts: { steps: 2, ok: 1, failed: 1 },
      failedStep: { cmd: 'click', error: expect.stringMatching(/DOM changes/) },
      steps: [
        { index: 1, cmd: 'click', ok: false },
        { index: 2, cmd: 'click', ok: true, resultPreview: 'later command completed' },
      ],
    });
    expect(cdpTest.formatBatchResults(batchResults, 'plain'))
      .toMatch(/\[1\/2\] click \(error\)[\s\S]*\[2\/2\] click[\s\S]*later command completed/);

    const flowRun = vi.fn(stale);
    const flow = JSON.parse(await cdpTest.flowStr({
      run: flowRun,
      settle: async () => '',
    }, 'click @1; click #later', { format: 'json', targetId: 'ABC12345' }));
    expect(flowRun).toHaveBeenCalledTimes(1);
    expect(flowRun).toHaveBeenCalledWith({ kind: 'command', cmd: 'click', args: ['@1'] });
    expect(flow).toMatchObject({
      halted: true,
      counts: { ok: 0, failed: 1, skipped: 1 },
      failedStep: { cmd: 'click', error: expect.stringMatching(/DOM changes/) },
    });

    const replayRun = vi.fn(stale);
    const replay = JSON.parse(await cdpTest.replayActionsStr({ run: replayRun }, [
      '--format', 'json', '--json', JSON.stringify(replayArtifact([
        { action: 'click', command: ['click', '@1'], replayable: true, needsInput: [] },
        { action: 'click', command: ['click', '#later'], replayable: true, needsInput: [] },
      ])),
    ]));
    expect(replayRun).toHaveBeenCalledTimes(1);
    expect(replayRun).toHaveBeenCalledWith({ cmd: 'click', args: ['@1'] });
    expect(replay).toMatchObject({
      halted: true,
      counts: { ok: 0, failed: 1 },
      failedStep: { command: ['click', '@1'], error: expect.stringMatching(/DOM changes/) },
    });

    const repeatRun = vi.fn(stale);
    await expect(cdpTest.repeatStr({ run: repeatRun }, ['3', 'click', '@1']))
      .rejects.toThrow(/DOM changes.*Repeat halted at iteration 1\/3/s);
    expect(repeatRun).toHaveBeenCalledTimes(1);
    expect(repeatRun).toHaveBeenCalledWith({ cmd: 'click', args: ['@1'] });
    expect(fixture.refMap.has(1)).toBe(false);
  });

  it('keeps a stale frame ref in the fresh-perceive recovery command', async () => {
    const fixture = await detachedRefActionFixture({ input: '@f2:1', frameRef: '@f2' });
    const action = JSON.parse(fixture.output);

    expect(action).toMatchObject({
      target: { input: '@f2:1' },
      dispatch: { ok: false },
      effects: {
        failure: {
          kind: 'stale-ref',
          nextCommand: 'cdp perceive ABC12345 --frame @f2',
        },
        diagnosis: {
          recovery: {
            strategy: 'refresh-perception',
            verifyCommand: 'cdp perceive ABC12345 --frame @f2',
          },
        },
      },
      nextSteps: expect.arrayContaining(['cdp perceive ABC12345 --frame @f2']),
    });
    expect(fixture.refState.frameRefs.get('@f2').refs.has(1)).toBe(false);
    expect(fixture.cdp.calls.some(call => call.method === 'Page.getFrameTree')).toBe(false);
  });
});
