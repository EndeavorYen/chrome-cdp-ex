#!/usr/bin/env node
import { createServer } from 'http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn, spawnSync } from 'child_process';

import { estimateTokenCount } from './benchmark-killer-path.mjs';
import { withLiveBenchmarkLock } from './benchmark-run-lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cdp = resolve(repoRoot, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const mcpServer = resolve(repoRoot, 'skills/chrome-cdp-ex/scripts/mcp-server.mjs');
const page = resolve(__dirname, 'smoke-page.html');

export function encodeMcpFrame(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

export function parseMcpFrames(buffer) {
  const messages = [];
  let rest = buffer;
  while (rest.length) {
    const text = rest.toString('utf8');
    const headerEnd = text.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = text.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) throw new Error(`Invalid MCP frame header: ${header}`);
    const length = Number(match[1]);
    const bodyStart = Buffer.byteLength(text.slice(0, headerEnd + 4), 'utf8');
    if (rest.length < bodyStart + length) break;
    messages.push(JSON.parse(rest.slice(bodyStart, bodyStart + length).toString('utf8')));
    rest = rest.slice(bodyStart + length);
  }
  return { messages, rest };
}

export function parseJsonOutput(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function browserCandidates() {
  return [
    ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'edge'],
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome'],
    ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'brave'],
    ['/usr/bin/google-chrome', 'chrome'],
    ['/usr/bin/chromium', 'chromium'],
    ['/usr/bin/microsoft-edge', 'edge'],
  ].filter(([p]) => existsSync(p));
}

function contentText(result = {}) {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter(entry => entry?.type === 'text')
    .map(entry => String(entry.text || ''))
    .join('\n')
    .trim();
}

function createMcpClient(env) {
  const child = spawn(process.execPath, [mcpServer], {
    cwd: repoRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let stdout = Buffer.alloc(0);
  let stderr = '';
  const pending = new Map();

  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.on('data', chunk => {
    stdout = Buffer.concat([stdout, chunk]);
    let parsed;
    try {
      parsed = parseMcpFrames(stdout);
    } catch (error) {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      return;
    }
    stdout = parsed.rest;
    for (const message of parsed.messages) {
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        entry.resolve(message.result);
      }
    }
  });
  child.on('error', error => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  });
  child.on('close', code => {
    for (const entry of pending.values()) {
      entry.reject(new Error(`MCP server exited with ${code}; stderr=${stderr}`));
    }
    pending.clear();
  });

  return {
    stderr: () => stderr,
    request(method, params = {}, timeout = 20000) {
      const id = nextId++;
      const payload = { jsonrpc: '2.0', id, method, params };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP ${method} timed out after ${timeout}ms; stderr=${stderr}`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(encodeMcpFrame(payload));
      });
    },
    close() {
      child.kill('SIGTERM');
    },
  };
}

async function protocolStep({ client, steps, method, params = {}, name = method, timeout = 20000 }) {
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let status = 0;
  try {
    stdout = JSON.stringify(await client.request(method, params, timeout));
  } catch (error) {
    status = 1;
    stderr = error.message || String(error);
  }
  const step = {
    name,
    mcpMethod: method,
    command: ['mcp', method],
    startedAt,
    endedAt: Date.now(),
    status,
    stdout,
    stderr,
    benchmarkProbe: true,
  };
  steps.push(step);
  if (status !== 0) throw new Error(`${method} failed: ${stderr}`);
  return step;
}

async function toolStep({ client, steps, tool, args = {}, command, name = tool, timeout = 30000, expectedFailure = false, benchmarkProbe = false }) {
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let status = 0;
  try {
    const result = await client.request('tools/call', { name: tool, arguments: args }, timeout);
    stdout = contentText(result);
    status = result.isError ? 1 : 0;
  } catch (error) {
    status = 1;
    stderr = error.message || String(error);
  }
  const step = {
    name,
    mcpTool: tool,
    command,
    startedAt,
    endedAt: Date.now(),
    status,
    stdout,
    stderr,
    expectedFailure,
    benchmarkProbe,
  };
  steps.push(step);
  if (!expectedFailure && status !== 0) {
    throw new Error(`${tool} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  return step;
}

export function runCliProcess(command, args = [], {
  cwd = repoRoot,
  env = process.env,
  timeout = 30000,
  maxBuffer = 10 * 1024 * 1024,
} = {}) {
  return new Promise(resolveRun => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let error = null;
    let settled = false;
    const finish = (status, signal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ status, signal, stdout, stderr, error });
    };
    const append = (current, chunk, stream) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next, 'utf8') > maxBuffer && !error) {
        error = new Error(`${stream} exceeded ${maxBuffer} bytes`);
        child.kill('SIGTERM');
      }
      return next;
    };
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk, 'stdout'); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk, 'stderr'); });
    child.once('error', spawnError => {
      error = spawnError;
      finish(1);
    });
    child.once('close', (code, signal) => finish(code ?? 1, signal));
    const timer = setTimeout(() => {
      error = new Error(`Process timed out after ${timeout}ms`);
      child.kill('SIGTERM');
    }, timeout);
  });
}

async function cliStep({ env, steps, args, name = args[0], timeout = 30000 }) {
  const startedAt = Date.now();
  const result = await runCliProcess(process.execPath, [cdp, ...args], {
    cwd: repoRoot,
    env,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  const step = {
    name,
    command: args,
    startedAt,
    endedAt: Date.now(),
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
  steps.push(step);
  if (step.status !== 0) {
    throw new Error(`cdp ${args.join(' ')} failed\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
  }
  return step;
}

function stepDuration(step = {}) {
  return Math.max(0, (step.endedAt ?? step.startedAt ?? 0) - (step.startedAt ?? 0));
}

function stepText(step = {}) {
  return `${step.stdout || ''}${step.stderr || ''}`;
}

function stepModel(step = {}) {
  return parseJsonOutput(stepText(step));
}

function isUsefulObservation(step = {}) {
  const model = stepModel(step);
  return [
    'chrome-cdp-ex.open.v1',
    'chrome-cdp-ex.visible-controls.v1',
    'chrome-cdp-ex.overlays.v1',
    'chrome-cdp-ex.perceive.v1',
    'chrome-cdp-ex.qa-page.v1',
    'chrome-cdp-ex.report.v1',
  ].includes(model?.schema);
}

function isActionEvidence(step = {}) {
  const model = stepModel(step);
  if (model?.schema === 'chrome-cdp-ex.action.v1') return true;
  if (model?.schema === 'chrome-cdp-ex.semantic-interaction.v1') return Boolean(model.action);
  return false;
}

function isReportTimeline(step = {}) {
  const model = stepModel(step);
  return model?.schema === 'chrome-cdp-ex.report.v1' && Array.isArray(model.actions);
}

function semanticVerificationPassed(step = {}) {
  const model = stepModel(step);
  if (model?.schema !== 'chrome-cdp-ex.semantic-interaction.v1') return false;
  return model.verdict === 'pass'
    && Array.isArray(model.assertions)
    && model.assertions.length > 0
    && model.assertions.every(assertion => assertion.status === 'pass');
}

function toolsListContains(step = {}, names = []) {
  const model = stepModel(step);
  const tools = Array.isArray(model?.tools) ? model.tools.map(tool => tool.name) : [];
  return names.every(name => tools.includes(name));
}

function overlayRecoveryCovered(steps = []) {
  const overlay = steps.find(step => step.name === 'overlay');
  const dismiss = steps.find(step => step.name === 'dismiss-modal');
  const overlayModel = stepModel(overlay);
  const dismissModel = stepModel(dismiss);
  return overlayModel?.schema === 'chrome-cdp-ex.overlays.v1'
    && overlayModel.blocking === true
    && /dismiss-modal/.test(String(overlayModel.nextCommand || ''))
    && dismissModel?.schema === 'chrome-cdp-ex.action.v1'
    && dismissModel.dispatch?.ok === true;
}

function gateCriterion(name, passed, actual, limit, recommendation) {
  return { name, passed, actual, limit, recommendation };
}

const MCP_TOOL_OUTPUT_TOKENS_MAX = 3200;
const MCP_USEFUL_OBSERVATION_TOKENS_MAX = 5000;
export const PROBLEM_FINDING_TASK_ID = 'problem-finding-v1';
const PROBLEM_FINDING_CHECKPOINTS = Object.freeze([
  'open',
  'controls',
  'overlay',
  'dismiss-modal',
  'verify-click',
  'report',
]);

export function summarizeMcpBenchmarkRun({ startedAt, endedAt, target = '', steps = [], browser = '', port = null, url = '' } = {}) {
  const normalizedSteps = steps.map(step => {
    const text = stepText(step);
    return {
      name: step.name,
      mcpMethod: step.mcpMethod || null,
      mcpTool: step.mcpTool || null,
      command: step.command || [],
      commandText: step.mcpTool
        ? `mcp tools/call ${step.mcpTool}`
        : `mcp ${step.mcpMethod || step.name}`,
      ok: step.status === 0 || Boolean(step.expectedFailure),
      status: step.status,
      expectedFailure: Boolean(step.expectedFailure),
      benchmarkProbe: Boolean(step.benchmarkProbe),
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      durationMs: stepDuration(step),
      outputChars: text.length,
      estimatedTokens: estimateTokenCount(text.length),
      hasUsefulObservation: isUsefulObservation(step),
      hasActionEvidence: isActionEvidence(step),
    };
  });
  const toolSteps = normalizedSteps.filter(step => step.mcpTool && !step.benchmarkProbe);
  const protocolSteps = normalizedSteps.filter(step => step.mcpMethod);
  const failed = normalizedSteps.find(step => !step.ok);
  const firstObservation = toolSteps.find(step => step.ok && step.hasUsefulObservation) || null;
  const firstActionEvidence = toolSteps.find(step => step.ok && step.hasActionEvidence) || null;
  const reportStep = toolSteps.find(step => step.name === 'report') || null;
  const outputChars = normalizedSteps.reduce((sum, step) => sum + step.outputChars, 0);
  const biggestOutputStep = normalizedSteps.reduce((biggest, step) => (
    !biggest || step.estimatedTokens > biggest.estimatedTokens ? step : biggest
  ), null);
  const slowestStep = normalizedSteps.reduce((slowest, step) => (
    !slowest || step.durationMs > slowest.durationMs ? step : slowest
  ), null);
  const toolListStep = steps.find(step => step.name === 'tools-list');
  const verifyStep = steps.find(step => step.name === 'verify-click');
  const reportModel = stepModel(steps.find(step => step.name === 'report'));
  const perToolOutputTokens = toolSteps.map(step => ({
    name: step.name,
    tool: step.mcpTool,
    commandText: step.commandText,
    outputChars: step.outputChars,
    estimatedTokens: step.estimatedTokens,
  }));
  const biggestToolOutputStep = perToolOutputTokens.reduce((biggest, step) => (
    !biggest || step.estimatedTokens > biggest.estimatedTokens ? step : biggest
  ), null);
  const usefulObservationTokens = toolSteps
    .filter(step => step.hasUsefulObservation)
    .reduce((sum, step) => sum + step.estimatedTokens, 0);
  const criteria = [
    gateCriterion('run-success', !failed, failed?.name || null, 'no failed step', 'Fix the failed MCP tool call before using this run as evidence.'),
    gateCriterion('tool-call-budget', toolSteps.length <= 6, toolSteps.length, '<= 6', 'Keep the MCP problem-finding path to six tool calls or fewer.'),
    gateCriterion('first-useful-observation', firstObservation && firstObservation.endedAt - startedAt <= 6000, firstObservation ? firstObservation.endedAt - startedAt : null, '<= 6000ms', 'MCP should produce a useful observation quickly enough to guide the next tool call.'),
    gateCriterion('first-action-evidence', firstActionEvidence && firstActionEvidence.endedAt - startedAt <= 9000, firstActionEvidence ? firstActionEvidence.endedAt - startedAt : null, '<= 9000ms', 'MCP mutating calls should return action evidence without an extra manual observe turn.'),
    gateCriterion('output-token-budget', estimateTokenCount(outputChars) <= 12000, estimateTokenCount(outputChars), '<= 12000 tokens', 'Keep MCP output bounded so tool envelopes do not hide token regressions.'),
    gateCriterion('useful-observation-token-budget', usefulObservationTokens <= MCP_USEFUL_OBSERVATION_TOKENS_MAX, usefulObservationTokens, `<= ${MCP_USEFUL_OBSERVATION_TOKENS_MAX} useful-observation tokens`, 'Keep MCP observations compact enough to preserve context for recovery decisions.'),
    gateCriterion('mcp-tool-output-budget', (biggestToolOutputStep?.estimatedTokens ?? 0) <= MCP_TOOL_OUTPUT_TOKENS_MAX, biggestToolOutputStep?.estimatedTokens ?? 0, `<= ${MCP_TOOL_OUTPUT_TOKENS_MAX} tokens/tool`, 'Keep any single MCP tool response from dominating the handoff; inspect the culprit tool output.'),
    gateCriterion('mcp-recovery-tool-coverage', toolsListContains(toolListStep, ['controls', 'overlay', 'dismiss_modal', 'verify_click']), true, 'required tools present', 'MCP must expose the recovery tools needed after a blocked click.'),
    gateCriterion('overlay-recovery-covered', overlayRecoveryCovered(steps), true, 'overlay -> dismiss_modal action', 'A visible overlay should be diagnosable and recoverable through MCP-only tools.'),
    gateCriterion('semantic-verification', semanticVerificationPassed(verifyStep), true, 'verify_click pass', 'MCP should complete click plus expected text verification in one tool call.'),
    gateCriterion('report-timeline', isReportTimeline(steps.find(step => step.name === 'report')), true, 'report actions present', 'MCP report should hand off the action timeline after recovery.'),
  ];
  const passedCount = criteria.filter(criterion => criterion.passed).length;
  return {
    schema: 'chrome-cdp-ex.mcp-benchmark.v1',
    scenario: 'mcp-problem-finding',
    taskId: PROBLEM_FINDING_TASK_ID,
    semanticCheckpoints: [...PROBLEM_FINDING_CHECKPOINTS],
    target,
    browser,
    port,
    url,
    success: !failed,
    failedStep: failed?.name || null,
    metrics: {
      totalMs: Math.max(0, (endedAt ?? startedAt ?? 0) - (startedAt ?? 0)),
      protocolCalls: protocolSteps.length,
      toolCalls: toolSteps.length,
      firstUsefulObservationMs: firstObservation ? Math.max(0, firstObservation.endedAt - startedAt) : null,
      firstActionEvidenceMs: firstActionEvidence ? Math.max(0, firstActionEvidence.endedAt - startedAt) : null,
      goldenPathMs: reportStep && reportModel?.schema === 'chrome-cdp-ex.report.v1'
        ? Math.max(0, reportStep.endedAt - startedAt)
        : null,
      outputChars,
      estimatedOutputTokens: estimateTokenCount(outputChars),
      usefulObservationTokens,
      actionEvidenceToolCalls: toolSteps.filter(step => step.hasActionEvidence).length,
      maxStepEstimatedTokens: biggestOutputStep?.estimatedTokens ?? 0,
      maxToolOutputTokens: biggestToolOutputStep?.estimatedTokens ?? 0,
      perToolOutputTokens,
      maxStepDurationMs: slowestStep?.durationMs ?? 0,
      biggestOutputStep: biggestOutputStep
        ? { name: biggestOutputStep.name, commandText: biggestOutputStep.commandText, estimatedTokens: biggestOutputStep.estimatedTokens }
        : null,
      biggestToolOutputStep,
      slowestStep: slowestStep
        ? { name: slowestStep.name, commandText: slowestStep.commandText, durationMs: slowestStep.durationMs }
        : null,
      overlayRecoveryCovered: overlayRecoveryCovered(steps),
      semanticVerificationPassed: semanticVerificationPassed(verifyStep),
      reportTimeline: Boolean(reportModel?.schema === 'chrome-cdp-ex.report.v1' && Array.isArray(reportModel.actions)),
      reportActionCount: Array.isArray(reportModel?.actions) ? reportModel.actions.length : 0,
    },
    gate: {
      schema: 'chrome-cdp-ex.mcp-benchmark-gate.v1',
      profile: 'mcp-problem-finding',
      passed: passedCount === criteria.length,
      passedCount,
      total: criteria.length,
      criteria,
    },
    steps: normalizedSteps,
  };
}

export function summarizeCliBenchmarkRun({ startedAt, endedAt, target = '', steps = [], browser = '', port = null, url = '' } = {}) {
  const normalizedSteps = steps.map(step => {
    const text = stepText(step);
    return {
      name: step.name,
      command: step.command || [],
      commandText: `cdp ${(step.command || []).join(' ')}`,
      ok: step.status === 0 || Boolean(step.expectedFailure),
      status: step.status,
      expectedFailure: Boolean(step.expectedFailure),
      benchmarkProbe: Boolean(step.benchmarkProbe),
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      durationMs: stepDuration(step),
      outputChars: text.length,
      estimatedTokens: estimateTokenCount(text.length),
      hasUsefulObservation: isUsefulObservation(step),
      hasActionEvidence: isActionEvidence(step),
    };
  });
  const commandSteps = normalizedSteps.filter(step => !step.benchmarkProbe);
  const failed = normalizedSteps.find(step => !step.ok);
  const firstObservation = commandSteps.find(step => step.ok && step.hasUsefulObservation) || null;
  const firstActionEvidence = commandSteps.find(step => step.ok && step.hasActionEvidence) || null;
  const outputChars = normalizedSteps.reduce((sum, step) => sum + step.outputChars, 0);
  const biggestOutputStep = normalizedSteps.reduce((biggest, step) => (
    !biggest || step.estimatedTokens > biggest.estimatedTokens ? step : biggest
  ), null);
  const slowestStep = normalizedSteps.reduce((slowest, step) => (
    !slowest || step.durationMs > slowest.durationMs ? step : slowest
  ), null);
  const usefulObservationTokens = commandSteps
    .filter(step => step.hasUsefulObservation)
    .reduce((sum, step) => sum + step.estimatedTokens, 0);
  const verifyStep = steps.find(step => step.name === 'verify-click');
  const reportStep = steps.find(step => step.name === 'report');
  const reportModel = stepModel(reportStep);
  const criteria = [
    gateCriterion('run-success', !failed, failed?.name || null, 'no failed step', 'Fix the failed CLI command before comparing routes.'),
    gateCriterion('command-call-budget', commandSteps.length <= 6, commandSteps.length, '<= 6', 'Keep the matched CLI path to the same six semantic commands as MCP.'),
    gateCriterion('first-useful-observation', firstObservation && firstObservation.endedAt - startedAt <= 6000, firstObservation ? firstObservation.endedAt - startedAt : null, '<= 6000ms', 'CLI should produce a useful observation within the matched route budget.'),
    gateCriterion('first-action-evidence', firstActionEvidence && firstActionEvidence.endedAt - startedAt <= 9000, firstActionEvidence ? firstActionEvidence.endedAt - startedAt : null, '<= 9000ms', 'CLI mutating commands should return action evidence without another observe turn.'),
    gateCriterion('output-token-budget', estimateTokenCount(outputChars) <= 12000, estimateTokenCount(outputChars), '<= 12000 tokens', 'Keep matched CLI output bounded.'),
    gateCriterion('useful-observation-token-budget', usefulObservationTokens <= MCP_USEFUL_OBSERVATION_TOKENS_MAX, usefulObservationTokens, `<= ${MCP_USEFUL_OBSERVATION_TOKENS_MAX} useful-observation tokens`, 'Keep matched CLI observations compact.'),
    gateCriterion('cli-command-output-budget', (biggestOutputStep?.estimatedTokens ?? 0) <= MCP_TOOL_OUTPUT_TOKENS_MAX, biggestOutputStep?.estimatedTokens ?? 0, `<= ${MCP_TOOL_OUTPUT_TOKENS_MAX} tokens/command`, 'Keep a single CLI response from dominating the comparison.'),
    gateCriterion('overlay-recovery-covered', overlayRecoveryCovered(steps), true, 'overlay -> dismiss-modal action', 'The matched CLI path must diagnose and dismiss the same overlay.'),
    gateCriterion('semantic-verification', semanticVerificationPassed(verifyStep), true, 'verify-click pass', 'The matched CLI path must verify the same click outcome.'),
    gateCriterion('report-timeline', isReportTimeline(reportStep), true, 'report actions present', 'The matched CLI path must return the same report window.'),
  ];
  const passedCount = criteria.filter(criterion => criterion.passed).length;
  return {
    schema: 'chrome-cdp-ex.cli-benchmark.v1',
    scenario: 'cli-problem-finding',
    taskId: PROBLEM_FINDING_TASK_ID,
    semanticCheckpoints: [...PROBLEM_FINDING_CHECKPOINTS],
    target,
    browser,
    port,
    url,
    success: !failed,
    failedStep: failed?.name || null,
    metrics: {
      totalMs: Math.max(0, (endedAt ?? startedAt ?? 0) - (startedAt ?? 0)),
      commandCalls: commandSteps.length,
      firstUsefulObservationMs: firstObservation ? Math.max(0, firstObservation.endedAt - startedAt) : null,
      firstActionEvidenceMs: firstActionEvidence ? Math.max(0, firstActionEvidence.endedAt - startedAt) : null,
      goldenPathMs: reportStep && reportModel?.schema === 'chrome-cdp-ex.report.v1'
        ? Math.max(0, reportStep.endedAt - startedAt)
        : null,
      outputChars,
      estimatedOutputTokens: estimateTokenCount(outputChars),
      usefulObservationTokens,
      maxStepEstimatedTokens: biggestOutputStep?.estimatedTokens ?? 0,
      maxStepDurationMs: slowestStep?.durationMs ?? 0,
      biggestOutputStep: biggestOutputStep
        ? { name: biggestOutputStep.name, commandText: biggestOutputStep.commandText, estimatedTokens: biggestOutputStep.estimatedTokens }
        : null,
      slowestStep: slowestStep
        ? { name: slowestStep.name, commandText: slowestStep.commandText, durationMs: slowestStep.durationMs }
        : null,
      overlayRecoveryCovered: overlayRecoveryCovered(steps),
      semanticVerificationPassed: semanticVerificationPassed(verifyStep),
      reportTimeline: isReportTimeline(reportStep),
      reportActionCount: Array.isArray(reportModel?.actions) ? reportModel.actions.length : 0,
    },
    gate: {
      schema: 'chrome-cdp-ex.cli-benchmark-gate.v1',
      profile: 'cli-problem-finding',
      passed: passedCount === criteria.length,
      passedCount,
      total: criteria.length,
      criteria,
    },
    steps: normalizedSteps,
  };
}

export function formatMcpBenchmarkReport(summary) {
  const lines = [
    `chrome-cdp-ex MCP benchmark: ${summary.scenario}`,
    `Success: ${summary.success ? 'yes' : 'no'}${summary.failedStep ? ` (failed at ${summary.failedStep})` : ''}`,
    `Target: ${summary.target || '(none)'}`,
    `Total time: ${summary.metrics.totalMs} ms`,
    `Protocol calls: ${summary.metrics.protocolCalls}`,
    `Tool calls: ${summary.metrics.toolCalls}`,
    `First useful observation: ${summary.metrics.firstUsefulObservationMs ?? 'n/a'} ms`,
    `First action evidence: ${summary.metrics.firstActionEvidenceMs ?? 'n/a'} ms`,
    `Golden path complete: ${summary.metrics.goldenPathMs ?? 'n/a'} ms`,
    `Estimated output tokens: ${summary.metrics.estimatedOutputTokens}`,
    `Useful observation tokens: ${summary.metrics.usefulObservationTokens}`,
    `Biggest tool output: ${summary.metrics.biggestToolOutputStep?.tool || 'n/a'} (${summary.metrics.biggestToolOutputStep?.estimatedTokens ?? 'n/a'} tokens)`,
    `Action evidence tool calls: ${summary.metrics.actionEvidenceToolCalls}`,
    `Overlay recovery covered: ${summary.metrics.overlayRecoveryCovered ? 'yes' : 'no'}`,
    `Semantic verification: ${summary.metrics.semanticVerificationPassed ? 'pass' : 'fail'}`,
    `Report timeline: ${summary.metrics.reportTimeline ? `yes (${summary.metrics.reportActionCount} actions)` : 'no'}`,
    `Quality gate: ${summary.gate.passed ? 'pass' : 'fail'}`,
    `Gate checks: ${summary.gate.passedCount}/${summary.gate.total} pass`,
    '',
  ];
  const failed = summary.gate.criteria.filter(criterion => !criterion.passed);
  if (failed.length) {
    lines.push('Gate failures:');
    for (const criterion of failed) {
      lines.push(`  - ${criterion.name}: actual ${criterion.actual} limit ${criterion.limit} (${criterion.recommendation})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function parseMcpBenchmarkArgs(argv = []) {
  const opts = { json: false, route: 'mcp' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--route') opts.route = argv[++i] || 'mcp';
  }
  return opts;
}

export async function runMcpBenchmark(opts = {}) {
  if (!opts.skipLock) {
    const port = Number(opts.port || process.env.CDP_MCP_BENCH_PORT || 9335);
    const serverPort = Number(opts.serverPort || process.env.CDP_MCP_BENCH_HTTP_PORT || 41739);
    return withLiveBenchmarkLock({
      name: 'benchmark:mcp',
      port,
      serverPort,
      browser: 'auto',
      profilePrefix: 'chrome-cdp-ex-mcp-bench',
    }, run => runMcpBenchmark({
      ...opts,
      skipLock: true,
      port: run.metadata.port,
      serverPort: run.metadata.serverPort,
      profileDir: run.metadata.profileDir,
      liveRun: run,
    }));
  }
  const {
    port = Number(process.env.CDP_MCP_BENCH_PORT || 9335),
    serverPort = Number(process.env.CDP_MCP_BENCH_HTTP_PORT || 41739),
    json = false,
    profileDir: requestedProfileDir = null,
    liveRun = null,
  } = opts;
  if (!existsSync(cdp)) throw new Error(`cdp script not found: ${cdp}`);
  if (!existsSync(mcpServer)) throw new Error(`MCP server not found: ${mcpServer}`);
  if (!existsSync(page)) throw new Error(`smoke page not found: ${page}`);
  const candidates = browserCandidates();
  if (candidates.length === 0) throw new Error('no supported Chrome/Edge/Brave browser binary found');

  const [browserPath, browserName] = candidates[0];
  const profileDir = requestedProfileDir || mkdtempSync(resolve(tmpdir(), `chrome-cdp-ex-mcp-bench-${browserName}-`));
  const steps = [];
  let browser;
  let server;
  let client;
  let startedAt = Date.now();

  const cleanup = () => {
    if (client) client.close();
    if (browser && !browser.killed) browser.kill('SIGTERM');
    if (server) server.close();
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  };

  try {
    server = createServer((req, res) => {
      if (req.url === '/' || req.url === '/smoke-page.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(page));
        return;
      }
      if (req.url?.startsWith('/api/fail')) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"ok":false,"error":"mcp benchmark diagnostic"}');
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise((resolveServer, reject) => {
      server.once('error', reject);
      server.listen(serverPort, '127.0.0.1', resolveServer);
    });
    liveRun?.heartbeat();

    const url = `http://127.0.0.1:${serverPort}/smoke-page.html`;
    browser = spawn(browserPath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    browser.unref();
    liveRun?.heartbeat();

    const env = { ...process.env, CDP_PORT: String(port) };
    let reachable = false;
    for (let i = 0; i < 30; i++) {
      const res = spawnSync(process.execPath, [cdp, 'list'], {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        timeout: 5000,
      });
      if (res.status === 0) {
        reachable = true;
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    if (!reachable) throw new Error('Browser did not become reachable via cdp list');

    startedAt = Date.now();
    client = createMcpClient(env);
    await protocolStep({ client, steps, method: 'initialize', params: {}, name: 'initialize' });
    await protocolStep({ client, steps, method: 'tools/list', params: {}, name: 'tools-list' });

    const open = await toolStep({
      client,
      steps,
      tool: 'open_or_attach',
      args: { url, confirm: true },
      command: ['open', url, '--format', 'json'],
      name: 'open',
      timeout: 40000,
    });
    const openModel = stepModel(open);
    const target = openModel?.targetPrefix;
    if (!target) throw new Error(`open_or_attach did not return targetPrefix\n${open.stdout}`);

    await toolStep({
      client,
      steps,
      tool: 'controls',
      args: { target, selector: 'main', limit: 12 },
      command: ['controls', target, '--selector', 'main', '--limit', '12', '--format', 'json'],
      name: 'controls',
    });
    await toolStep({
      client,
      steps,
      tool: 'overlay',
      args: { target },
      command: ['overlay', target, '--format', 'json'],
      name: 'overlay',
    });
    await toolStep({
      client,
      steps,
      tool: 'dismiss_modal',
      args: { target, confirm: true },
      command: ['dismiss-modal', target, '--format', 'json'],
      name: 'dismiss-modal',
    });
    await toolStep({
      client,
      steps,
      tool: 'verify_click',
      args: {
        target,
        selector: '#combat',
        expectText: '戰鬥勝利',
        noConsoleErrors: true,
        confirm: true,
      },
      command: ['verify-click', target, '#combat', '--expect-text', '戰鬥勝利', '--no-console-errors', '--format', 'json'],
      name: 'verify-click',
    });
    await toolStep({
      client,
      steps,
      tool: 'report',
      args: { target, last: 5 },
      command: ['report', target, '--last', '5', '--format', 'json'],
      name: 'report',
    });

    const summary = summarizeMcpBenchmarkRun({
      startedAt,
      endedAt: Date.now(),
      target,
      steps,
      browser: browserName,
      port,
      url,
    });
    return json ? JSON.stringify(summary, null, 2) : formatMcpBenchmarkReport(summary);
  } finally {
    cleanup();
  }
}

export async function runCliBenchmark(opts = {}) {
  if (!opts.skipLock) {
    const port = Number(opts.port || process.env.CDP_CLI_BENCH_PORT || 9336);
    const serverPort = Number(opts.serverPort || process.env.CDP_CLI_BENCH_HTTP_PORT || 41740);
    return withLiveBenchmarkLock({
      name: 'benchmark:cli',
      port,
      serverPort,
      browser: 'auto',
      profilePrefix: 'chrome-cdp-ex-cli-bench',
    }, run => runCliBenchmark({
      ...opts,
      skipLock: true,
      port: run.metadata.port,
      serverPort: run.metadata.serverPort,
      profileDir: run.metadata.profileDir,
      liveRun: run,
    }));
  }
  const {
    port = Number(process.env.CDP_CLI_BENCH_PORT || 9336),
    serverPort = Number(process.env.CDP_CLI_BENCH_HTTP_PORT || 41740),
    json = false,
    profileDir: requestedProfileDir = null,
    liveRun = null,
  } = opts;
  if (!existsSync(cdp)) throw new Error(`cdp script not found: ${cdp}`);
  if (!existsSync(page)) throw new Error(`smoke page not found: ${page}`);
  const candidates = browserCandidates();
  if (candidates.length === 0) throw new Error('no supported Chrome/Edge/Brave browser binary found');

  const [browserPath, browserName] = candidates[0];
  const profileDir = requestedProfileDir || mkdtempSync(resolve(tmpdir(), `chrome-cdp-ex-cli-bench-${browserName}-`));
  const steps = [];
  let browser;
  let server;
  let startedAt = Date.now();

  const cleanup = () => {
    if (browser && !browser.killed) browser.kill('SIGTERM');
    if (server) server.close();
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  };

  try {
    server = createServer((req, res) => {
      if (req.url === '/' || req.url === '/smoke-page.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(page));
        return;
      }
      if (req.url?.startsWith('/api/fail')) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"ok":false,"error":"cli benchmark diagnostic"}');
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise((resolveServer, reject) => {
      server.once('error', reject);
      server.listen(serverPort, '127.0.0.1', resolveServer);
    });
    liveRun?.heartbeat();

    const url = `http://127.0.0.1:${serverPort}/smoke-page.html`;
    browser = spawn(browserPath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    browser.unref();
    liveRun?.heartbeat();

    const env = { ...process.env, CDP_PORT: String(port) };
    let reachable = false;
    for (let i = 0; i < 30; i++) {
      const result = spawnSync(process.execPath, [cdp, 'list'], {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        timeout: 5000,
      });
      if (result.status === 0) {
        reachable = true;
        break;
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 300));
    }
    if (!reachable) throw new Error('Browser did not become reachable via cdp list');

    startedAt = Date.now();
    const open = await cliStep({
      env,
      steps,
      args: ['open', url, '--attach-timeout-ms', '5000', '--ready-timeout-ms', '5000', '--ready-selector', '#combat', '--format', 'json'],
      name: 'open',
      timeout: 40000,
    });
    const target = stepModel(open)?.targetPrefix;
    if (!target) throw new Error(`open did not return targetPrefix\n${open.stdout}`);

    await cliStep({ env, steps, args: ['controls', target, '--selector', 'main', '--limit', '12', '--compact', '--format', 'json'], name: 'controls' });
    await cliStep({ env, steps, args: ['overlay', target, '--format', 'json'], name: 'overlay' });
    await cliStep({ env, steps, args: ['dismiss-modal', target, '--format', 'json'], name: 'dismiss-modal' });
    await cliStep({
      env,
      steps,
      args: ['verify-click', target, '#combat', '--expect-text', '戰鬥勝利', '--no-console-errors', '--format', 'json'],
      name: 'verify-click',
    });
    await cliStep({ env, steps, args: ['report', target, '--last', '5', '--format', 'json', '--compact'], name: 'report' });

    const summary = summarizeCliBenchmarkRun({
      startedAt,
      endedAt: Date.now(),
      target,
      steps,
      browser: browserName,
      port,
      url,
    });
    return json ? JSON.stringify(summary, null, 2) : formatMcpBenchmarkReport({
      ...summary,
      metrics: { ...summary.metrics, protocolCalls: 0, toolCalls: summary.metrics.commandCalls, biggestToolOutputStep: summary.metrics.biggestOutputStep, actionEvidenceToolCalls: 2 },
    });
  } finally {
    cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const opts = parseMcpBenchmarkArgs(process.argv.slice(2));
  const runner = opts.route === 'cli' ? runCliBenchmark : runMcpBenchmark;
  runner(opts)
    .then(out => console.log(out))
    .catch(err => {
      console.error(`MCP benchmark failed: ${err.message || err}`);
      process.exit(1);
    });
}
