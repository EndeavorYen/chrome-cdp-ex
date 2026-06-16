#!/usr/bin/env node
import { createServer } from 'http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cdp = resolve(repoRoot, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const page = resolve(__dirname, 'smoke-page.html');

const MUTATING_COMMANDS = new Set([
  'click', 'fill', 'type', 'press', 'select', 'scroll', 'nav', 'back', 'forward',
  'reload', 'viewport', 'inject', 'dismiss-modal', 'dismissmodal', 'upload',
]);

export function estimateTokenCount(value) {
  const chars = typeof value === 'number' ? value : String(value || '').length;
  return Math.ceil(Math.max(0, chars) / 4);
}

function outputText(step) {
  return `${step.stdout || ''}${step.stderr || ''}`;
}

function stepModel(step = {}) {
  return step.model || null;
}

function hasReportTimeline(step) {
  const model = stepModel(step);
  if (model?.schema === 'chrome-cdp-ex.report.v1') return Array.isArray(model.actions);
  return /Session report:[\s\S]*Action timeline:/m.test(step.outputText || outputText(step));
}

function hasUsefulObservation(step) {
  const text = step.outputText || outputText(step);
  const model = stepModel(step);
  if (model?.schema === 'chrome-cdp-ex.perceive.v1') return true;
  if (model?.schema === 'chrome-cdp-ex.perceive-diff.v1') return true;
  if (model?.schema === 'chrome-cdp-ex.report.v1') return hasReportTimeline(step);
  return step.name === 'perceive'
    || step.name === 'report'
    || /^Page:/m.test(text)
    || /Coords: top-level viewport CSS px/.test(text)
    || hasReportTimeline(step);
}

function hasActionEvidence(step) {
  const text = step.outputText || outputText(step);
  const model = stepModel(step);
  const commandName = normalizeActionCommandName(step.command?.[0] || step.name);
  return Boolean(MUTATING_COMMANDS.has(commandName)
    && ((model?.schema === 'chrome-cdp-ex.action.v1' && (model.dispatch || model.outcome || model.verdict))
      || /^[a-z-]+: dispatched/m.test(text)
      || /Action failure:/m.test(text)
      || /success but observation timed out/i.test(text)));
}

function normalizeActionCommandName(value = '') {
  const name = String(value || '').toLowerCase();
  if (name === 'navigate') return 'nav';
  if (name === 'dismissmodal') return 'dismiss-modal';
  return name;
}

function mutatingCommandName(step = {}) {
  const commandName = normalizeActionCommandName(step.command?.[0] || step.name);
  return MUTATING_COMMANDS.has(commandName) ? commandName : null;
}

function differentiatorProbe(steps, predicate) {
  const matches = steps.filter(step => !step.benchmarkProbe && predicate(step));
  const successful = matches.some(step => step.ok);
  return {
    success: successful,
    durationMs: matches.reduce((sum, step) => sum + step.durationMs, 0),
    commandCalls: matches.length,
  };
}

function benchmarkDifferentiators(steps) {
  const modalOverlay = differentiatorProbe(steps, (step) => {
    const commandName = step.command?.[0] || step.name;
    return commandName === 'overlay' && /Overlay detector:/i.test(step.outputText || '');
  });
  const frameRefs = differentiatorProbe(steps, (step) => {
    const commandName = step.command?.[0] || step.name;
    return (commandName === 'frame' || step.name === 'perceive-frame') && /@f\d+/i.test(step.outputText || '');
  });
  const cssTrace = differentiatorProbe(steps, (step) => {
    const commandName = step.command?.[0] || step.name;
    const text = step.outputText || '';
    return commandName === 'cascade'
      && !/No matching CSS rules/i.test(text)
      && /(WIN|→|source|inline|sheet)/i.test(text);
  });
  const hmrDomUpdate = differentiatorProbe(steps, (step) => {
    const commandName = step.command?.[0] || step.name;
    const text = step.outputText || '';
    return (step.name === 'hmr-diff' || (commandName === 'perceive' && step.command?.includes('--diff')))
      && /hmr panel ready|spa|hot update/i.test(text)
      && /\+\+\+ Added|~~~ Text nodes updated|@/m.test(text);
  });
  const probes = [modalOverlay, frameRefs, cssTrace, hmrDomUpdate];
  const successRate = probes.filter(probe => probe.success).length / probes.length;
  return { modalOverlay, frameRefs, cssTrace, hmrDomUpdate, successRate };
}

function differentiatorHandoffMissingFields(model = {}) {
  const missing = [];
  if (model.schema === 'chrome-cdp-ex.overlays.v1') {
    if (!model.viewport || typeof model.viewport !== 'object') missing.push('viewport');
    if (!Number.isFinite(model.overlayCount)) missing.push('overlayCount');
    if (typeof model.blocking !== 'boolean') missing.push('blocking');
    const overlays = Array.isArray(model.overlays) ? model.overlays : null;
    if (!overlays) missing.push('overlays');
    if (model.blocking === true && !(overlays || []).some(overlay => (
      overlay?.blocking === true
      || overlay?.coversTarget === true
      || overlay?.kind === 'dialog'
    ))) {
      missing.push('overlays.blocking');
    }
    if (model.blocking === true && !isExecutableRecoveryCommand(model.nextCommand)) {
      missing.push('nextCommand');
    }
    return [...new Set(missing)];
  }

  if (model.schema === 'chrome-cdp-ex.frames.v1') {
    if (!Number.isFinite(model.frameCount)) missing.push('frameCount');
    const frames = Array.isArray(model.frames) ? model.frames : null;
    if (!frames) missing.push('frames');
    if (!(frames || []).some(frame => /^@f\d+$/.test(String(frame?.ref || '')))) {
      missing.push('frames.ref');
    }
    return [...new Set(missing)];
  }

  return missing;
}

function benchmarkDifferentiatorHandoffCoverage(steps) {
  const bySchema = {};
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (!['chrome-cdp-ex.overlays.v1', 'chrome-cdp-ex.frames.v1'].includes(model?.schema)) continue;
    total += 1;
    bySchema[model.schema] ||= { total: 0, covered: 0, missing: 0 };
    bySchema[model.schema].total += 1;
    const missingFields = differentiatorHandoffMissingFields(model);
    if (missingFields.length === 0) {
      covered += 1;
      bySchema[model.schema].covered += 1;
    } else {
      bySchema[model.schema].missing += 1;
      missing.push({
        name: step.name,
        schema: model.schema,
        commandText: step.commandText,
        missing: missingFields,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    bySchema,
    rate: total > 0 ? covered / total : null,
  };
}

function benchmarkStaleRefRecovery(steps) {
  const probes = steps.filter(step => step.expectedFailure && /stale-ref|Unknown ref|Refs were (cleared|invalidated)/i.test(step.outputText || ''));
  const recovered = probes.filter(step => /Next:\s*cdp perceive|Run "?perceive"?|Refresh refs/i.test(step.outputText || ''));
  return {
    success: probes.length > 0 && recovered.length === probes.length,
    durationMs: probes.reduce((sum, step) => sum + step.durationMs, 0),
    commandCalls: probes.length,
    recovered: recovered.length,
    rate: probes.length > 0 ? recovered.length / probes.length : 0,
  };
}

function isExecutableRecoveryCommand(value = '') {
  return /^(cdp\s+\S+|ulimit\s+-n\s+\d+|sudo\s+\S+|CDP_PORT=\S+\s+)/.test(String(value || '').trim());
}

function stepHasExecutableRecovery(step = {}) {
  const model = stepModel(step) || parseJsonOutput(step.outputText);
  if (Array.isArray(model?.nextSteps) && model.nextSteps.some(isExecutableRecoveryCommand)) return true;
  if (isExecutableRecoveryCommand(model?.recovery?.run)) return true;
  if (isExecutableRecoveryCommand(model?.recovery?.then)) return true;
  const text = step.outputText || outputText(step);
  const labeledCommands = [];
  for (const match of text.matchAll(/^\s*(?:Next|Run|Then):\s*(.+)$/gmi)) {
    labeledCommands.push(match[1]);
  }
  return labeledCommands.some(isExecutableRecoveryCommand);
}

function benchmarkCliRecoveryCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    if (step.status === 0) continue;
    total += 1;
    if (stepHasExecutableRecovery(step)) {
      covered += 1;
    } else {
      missing.push({
        name: step.name,
        commandText: step.commandText,
        status: step.status,
        expectedFailure: step.expectedFailure,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    rate: total > 0 ? covered / total : null,
  };
}

function benchmarkSessionStability(steps) {
  const probes = steps.filter(step => /^stability-/.test(step.name || ''));
  const failed = probes.find(step => !step.ok);
  const statusOk = probes.some(step => step.name === 'stability-status' && step.ok);
  const reportOk = probes.some(step => (
    step.name === 'stability-report'
    && step.ok
    && hasReportTimeline(step)
  ));
  return {
    enabled: probes.length > 0,
    success: probes.length > 0 && !failed && statusOk && reportOk,
    durationMs: probes.reduce((sum, step) => sum + step.durationMs, 0),
    commandCalls: probes.length,
    statusOk,
    reportOk,
    failedStep: failed?.name || (!statusOk && probes.length ? 'stability-status' : (!reportOk && probes.length ? 'stability-report' : null)),
  };
}

function benchmarkActionEvidenceCoverage(steps) {
  const byCommand = {};
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const command = mutatingCommandName(step);
    if (!command) continue;
    total += 1;
    byCommand[command] ||= { total: 0, covered: 0, missing: 0 };
    byCommand[command].total += 1;
    if (step.hasActionEvidence) {
      covered += 1;
      byCommand[command].covered += 1;
    } else {
      byCommand[command].missing += 1;
      missing.push({
        command,
        name: step.name,
        commandText: step.commandText,
        status: step.status,
        expectedFailure: step.expectedFailure,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    byCommand,
    rate: total > 0 ? covered / total : null,
  };
}

function actionEvidenceCompletenessMissingFields(model = {}) {
  const missing = [];
  const objectFields = ['target', 'dispatch', 'settle', 'effects', 'outcome', 'verdict'];
  if (typeof model.action !== 'string' || !model.action.trim()) missing.push('action');
  for (const field of objectFields) {
    if (!model[field] || typeof model[field] !== 'object') missing.push(field);
  }

  const target = model.target || {};
  if (!['targetId', 'input', 'resolvedBy', 'label'].some(field => typeof target[field] === 'string' && target[field].trim())) {
    missing.push('target');
  }

  const dispatch = model.dispatch || {};
  if (typeof dispatch.ok !== 'boolean') missing.push('dispatch.ok');
  if (typeof dispatch.method !== 'string' || !dispatch.method.trim()) missing.push('dispatch.method');

  const settle = model.settle || {};
  if (typeof settle.ok !== 'boolean') missing.push('settle.ok');
  if (!Number.isFinite(settle.durationMs)) missing.push('settle.durationMs');

  const effects = model.effects || {};
  const hasEvidence = Object.hasOwn(effects, 'domDiff')
    || typeof effects.domDiffSummary === 'string'
    || typeof effects.domDiffSample === 'string'
    || Boolean(effects.failure?.kind)
    || Boolean(effects.diagnosis?.kind);
  if (!hasEvidence) missing.push('effects.evidence');
  for (const field of ['consoleDelta', 'exceptionDelta', 'networkDelta']) {
    const delta = effects[field];
    if (!delta || typeof delta !== 'object' || !Number.isFinite(delta.count)) missing.push(`effects.${field}`);
  }

  const outcome = model.outcome || {};
  if (typeof outcome.status !== 'string' || !outcome.status.trim()) missing.push('outcome.status');

  const verdict = model.verdict || {};
  if (typeof verdict.status !== 'string' || !verdict.status.trim()) missing.push('verdict.status');
  if (typeof verdict.canContinue !== 'boolean') missing.push('verdict.canContinue');
  if (typeof verdict.needsRecovery !== 'boolean') missing.push('verdict.needsRecovery');

  if (!recommendationHasActionableContext(model.recommendation)) missing.push('recommendation');
  const nextSteps = Array.isArray(model.nextSteps) ? model.nextSteps : [];
  if (!nextSteps.some(value => /^cdp\s+\S+/.test(String(value || '')))) missing.push('nextSteps');
  return [...new Set(missing)];
}

function benchmarkActionEvidenceCompletenessCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (model?.schema !== 'chrome-cdp-ex.action.v1') continue;
    total += 1;
    const missingFields = actionEvidenceCompletenessMissingFields(model);
    if (missingFields.length === 0) {
      covered += 1;
    } else {
      missing.push({
        name: step.name,
        commandText: step.commandText,
        missing: missingFields,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    rate: total > 0 ? covered / total : null,
  };
}

function isFailedActionModel(model = {}) {
  if (model?.schema !== 'chrome-cdp-ex.action.v1') return false;
  return model.dispatch?.ok === false
    || model.outcome?.status === 'failed'
    || Boolean(model.effects?.failure?.kind);
}

function actionFailureDiagnosisMissingFields(model = {}) {
  const missing = [];
  const failure = model.effects?.failure || {};
  const diagnosis = model.effects?.diagnosis || {};
  const recovery = diagnosis.recovery || {};
  const recoveryCommands = Array.isArray(recovery.commands) ? recovery.commands : [];
  const recommendationCommands = Array.isArray(model.recommendation?.commands) ? model.recommendation.commands : [];
  const nextSteps = Array.isArray(model.nextSteps) ? model.nextSteps : [];

  if (typeof failure.kind !== 'string' || !failure.kind.trim()) missing.push('effects.failure.kind');
  if (!diagnosis || typeof diagnosis !== 'object' || typeof diagnosis.kind !== 'string' || !diagnosis.kind.trim()) missing.push('effects.diagnosis');
  if (diagnosis.status !== 'blocked' && diagnosis.status !== 'attention') missing.push('effects.diagnosis.status');
  if (!recovery || typeof recovery !== 'object') missing.push('effects.diagnosis.recovery');
  if (!recoveryCommands.some(entry => isExecutableRecoveryCommand(entry?.command))) missing.push('effects.diagnosis.recovery.commands');
  if (!isExecutableRecoveryCommand(recovery.verifyCommand || diagnosis.nextCommand)) missing.push('effects.diagnosis.recovery.verifyCommand');
  if (model.verdict?.canContinue !== false) missing.push('verdict.canContinue');
  if (model.verdict?.needsRecovery !== true) missing.push('verdict.needsRecovery');
  if (!isExecutableRecoveryCommand(model.verdict?.primaryNextStep)) missing.push('verdict.primaryNextStep');
  if (!recommendationHasActionableContext(model.recommendation) || !recommendationCommands.some(isExecutableRecoveryCommand)) missing.push('recommendation');
  if (!nextSteps.some(isExecutableRecoveryCommand)) missing.push('nextSteps');
  return [...new Set(missing)];
}

function benchmarkActionFailureDiagnosisCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (!isFailedActionModel(model)) continue;
    total += 1;
    const missingFields = actionFailureDiagnosisMissingFields(model);
    if (missingFields.length === 0) {
      covered += 1;
    } else {
      missing.push({
        name: step.name,
        commandText: step.commandText,
        missing: missingFields,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    rate: total > 0 ? covered / total : null,
  };
}

function parseJsonOutput(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function benchmarkHandoffNextStepsCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (!model?.schema || !/^chrome-cdp-ex\.(doctor|list|open|perceive|perceive-diff|action|report)\.v1$/.test(model.schema)) continue;
    total += 1;
    const hasNextSteps = Array.isArray(model.nextSteps) && model.nextSteps.some(value => /^cdp\s+\S+/.test(String(value || '')));
    if (hasNextSteps) {
      covered += 1;
    } else {
      missing.push({
        name: step.name,
        schema: model.schema,
        commandText: step.commandText,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    rate: total > 0 ? covered / total : null,
  };
}

function recommendationHasActionableContext(recommendation = {}) {
  if (!recommendation || typeof recommendation !== 'object') return false;
  const commands = Array.isArray(recommendation.commands) ? recommendation.commands : [];
  if (commands.some(value => /^cdp\s+\S+/.test(String(value || '')))) return true;
  for (const field of ['run', 'verifyCommand', 'after', 'ask', 'reason', 'strategy', 'source']) {
    if (typeof recommendation[field] === 'string' && recommendation[field].trim()) return true;
  }
  return false;
}

function benchmarkHandoffRecommendationCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (!model?.schema || !/^chrome-cdp-ex\.(doctor|list|open|perceive|perceive-diff|action|report)\.v1$/.test(model.schema)) continue;
    total += 1;
    if (recommendationHasActionableContext(model.recommendation)) {
      covered += 1;
    } else {
      missing.push({
        name: step.name,
        schema: model.schema,
        commandText: step.commandText,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    rate: total > 0 ? covered / total : null,
  };
}

function targetPrefixIsConcrete(value) {
  return typeof value === 'string' && value.trim() && value !== '<target>';
}

function hasPerceiveNextStepForTarget(model = {}, targetPrefix = '') {
  if (!targetPrefixIsConcrete(targetPrefix)) return false;
  const nextSteps = Array.isArray(model.nextSteps) ? model.nextSteps : [];
  return nextSteps.some(value => String(value || '').startsWith(`cdp perceive ${targetPrefix}`));
}

function targetHandoffMissingFields(model = {}) {
  const missing = [];
  if (model.schema === 'chrome-cdp-ex.open.v1') {
    if (!targetPrefixIsConcrete(model.targetPrefix)) missing.push('targetPrefix');
    if (typeof model.attached !== 'boolean') missing.push('attached');
    if (!['approved', 'pending'].includes(model.approval)) missing.push('approval');
    if (model.url && model.url !== 'about:blank' && model.navigation?.ok !== true) missing.push('navigation.ok');
    if (model.attached === true && model.ready?.ok !== true) missing.push('ready.ok');
    if (typeof model.recommendation?.run !== 'string' || !model.recommendation.run.startsWith(`cdp perceive ${model.targetPrefix}`)) {
      missing.push('recommendation.run');
    }
    if (!hasPerceiveNextStepForTarget(model, model.targetPrefix)) missing.push('nextSteps.perceive');
    return [...new Set(missing)];
  }

  if (model.schema === 'chrome-cdp-ex.list.v1') {
    if (!Number.isFinite(model.targetCount)) missing.push('targetCount');
    if (!Array.isArray(model.pages)) missing.push('pages');
    const pages = Array.isArray(model.pages) ? model.pages : [];
    if (pages.length > 0) {
      const firstPrefix = pages.find(page => targetPrefixIsConcrete(page?.targetPrefix))?.targetPrefix;
      if (!firstPrefix) missing.push('pages.targetPrefix');
      if (typeof model.recommendation?.run !== 'string' || !model.recommendation.run.startsWith(`cdp perceive ${firstPrefix}`)) {
        missing.push('recommendation.run');
      }
      if (!hasPerceiveNextStepForTarget(model, firstPrefix)) missing.push('nextSteps.perceive');
    } else {
      const nextSteps = Array.isArray(model.nextSteps) ? model.nextSteps : [];
      if (!nextSteps.some(value => /^cdp\s+open(\s|$)/.test(String(value || '')))) missing.push('nextSteps.open');
      if (!recommendationHasActionableContext(model.recommendation)) missing.push('recommendation');
    }
    return [...new Set(missing)];
  }

  return missing;
}

function benchmarkTargetHandoffCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (!['chrome-cdp-ex.open.v1', 'chrome-cdp-ex.list.v1'].includes(model?.schema)) continue;
    total += 1;
    const missingFields = targetHandoffMissingFields(model);
    if (missingFields.length === 0) {
      covered += 1;
    } else {
      missing.push({
        name: step.name,
        schema: model.schema,
        commandText: step.commandText,
        missing: missingFields,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    rate: total > 0 ? covered / total : null,
  };
}

function doctorOnboardingMissingFields(model = {}) {
  const missing = [];
  const wizard = model.wizard || {};
  if (typeof wizard.currentStep !== 'string' || !wizard.currentStep.trim()) {
    missing.push('wizard.currentStep');
  }
  const goldenPath = Array.isArray(wizard.goldenPath) ? wizard.goldenPath : [];
  for (const step of ['doctor', 'list/open', 'perceive', 'click/fill', 'since-action evidence', 'report']) {
    if (!goldenPath.includes(step)) missing.push('wizard.goldenPath');
  }
  const checkLabels = new Set((Array.isArray(model.checks) ? model.checks : [])
    .map(check => String(check?.label || ''))
    .filter(Boolean));
  for (const label of ['Node', 'FD limit', 'CDP', 'Tabs', 'Permission']) {
    if (!checkLabels.has(label)) missing.push(`checks.${label}`);
  }
  if (!recommendationHasActionableContext(model.recommendation)) {
    missing.push('recommendation');
  }
  const nextSteps = Array.isArray(model.nextSteps) ? model.nextSteps : [];
  if (!nextSteps.some(value => /^cdp\s+\S+/.test(String(value || '')))) {
    missing.push('nextSteps');
  }
  return [...new Set(missing)];
}

function benchmarkDoctorOnboardingCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (model?.schema !== 'chrome-cdp-ex.doctor.v1') continue;
    total += 1;
    const missingFields = doctorOnboardingMissingFields(model);
    if (missingFields.length === 0) {
      covered += 1;
    } else {
      missing.push({
        name: step.name,
        commandText: step.commandText,
        missing: missingFields,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    rate: total > 0 ? covered / total : null,
  };
}

function benchmarkReportLatestActionCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (model?.schema !== 'chrome-cdp-ex.report.v1' || !Array.isArray(model.actions) || model.actions.length === 0) continue;
    total += 1;
    const latest = model.latestAction;
    const hasLatestAction = latest
      && Number.isFinite(latest.index)
      && latest.action
      && latest.status;
    if (hasLatestAction) {
      covered += 1;
    } else {
      missing.push({
        name: step.name,
        commandText: step.commandText,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    rate: total > 0 ? covered / total : null,
  };
}

function benchmarkReportTimelineWindowCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (model?.schema !== 'chrome-cdp-ex.report.v1' || !Array.isArray(model.actions) || model.actions.length === 0) continue;
    total += 1;
    const timelineWindow = model.timelineWindow || {};
    const hasTimelineWindow = Number.isFinite(timelineWindow.total)
      && Number.isFinite(timelineWindow.shown)
      && Number.isFinite(timelineWindow.omitted)
      && (timelineWindow.limit === null || Number.isFinite(timelineWindow.limit))
      && timelineWindow.shown === model.actions.length
      && timelineWindow.total >= timelineWindow.shown
      && timelineWindow.omitted === timelineWindow.total - timelineWindow.shown
      && (timelineWindow.shown === 0 || (
        Number.isFinite(timelineWindow.startIndex)
        && Number.isFinite(timelineWindow.endIndex)
        && timelineWindow.endIndex - timelineWindow.startIndex + 1 === timelineWindow.shown
      ));
    if (hasTimelineWindow) {
      covered += 1;
    } else {
      missing.push({
        name: step.name,
        commandText: step.commandText,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    rate: total > 0 ? covered / total : null,
  };
}

function reportActionHasEvidence(action = {}) {
  const evidence = action.evidence || {};
  if (!evidence || typeof evidence !== 'object') return false;
  return [
    evidence.dispatchMethod,
    evidence.settleOk,
    evidence.effectSummary,
    evidence.effectSample,
    evidence.consoleSummary,
    evidence.exceptionSummary,
    evidence.networkSummary,
    evidence.failure,
    evidence.diagnosis,
  ].some(value => value !== null && value !== undefined && value !== '');
}

function reportArtifactMissingFields(model = {}) {
  const missing = [];
  if (typeof model.paths?.log !== 'string' || !model.paths.log.trim()) missing.push('paths.log');
  if (typeof model.paths?.screenshotDir !== 'string' || !model.paths.screenshotDir.trim()) missing.push('paths.screenshotDir');
  if (!Number.isFinite(model.counts?.actions) || model.counts.actions < 1) missing.push('counts.actions');
  if (!Number.isFinite(model.counts?.screenshots) || model.counts.screenshots < 0) missing.push('counts.screenshots');
  const actions = Array.isArray(model.actions) ? model.actions : [];
  if (!actions.length) missing.push('actions');
  if (!actions.some(reportActionHasEvidence)) missing.push('actions.evidence');
  if (!model.environment || typeof model.environment !== 'object') missing.push('environment');
  if (!recommendationHasActionableContext(model.recommendation)) missing.push('recommendation');
  const nextSteps = Array.isArray(model.nextSteps) ? model.nextSteps : [];
  if (!nextSteps.some(value => /^cdp\s+\S+/.test(String(value || '')))) missing.push('nextSteps');
  if (Number.isFinite(model.counts?.screenshots) && model.counts.screenshots > 0) {
    const screenshots = Array.isArray(model.screenshots) ? model.screenshots : [];
    if (!screenshots.some(shot => typeof shot?.path === 'string' && shot.path.trim())) {
      missing.push('screenshots.path');
    }
  }
  return [...new Set(missing)];
}

function benchmarkReportArtifactCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (model?.schema !== 'chrome-cdp-ex.report.v1') continue;
    const actions = Array.isArray(model.actions) ? model.actions : [];
    if (actions.length === 0 && !(model.counts?.actions > 0)) continue;
    total += 1;
    const missingFields = reportArtifactMissingFields(model);
    if (missingFields.length === 0) {
      covered += 1;
    } else {
      missing.push({
        name: step.name,
        commandText: step.commandText,
        missing: missingFields,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    rate: total > 0 ? covered / total : null,
  };
}

function perceptionSignalMissingFields(model = {}) {
  const missing = [];
  if (typeof model.targetPrefix !== 'string' || !model.targetPrefix.trim()) missing.push('targetPrefix');
  if (!model.page || typeof model.page !== 'object') missing.push('page');
  if (!model.viewport || typeof model.viewport !== 'object') missing.push('viewport');
  if (model.viewport?.coordinateSpace !== 'viewport-css-px') missing.push('viewport.coordinateSpace');
  if (!model.console || typeof model.console !== 'object') missing.push('console');
  if (!model.refs || typeof model.refs !== 'object') missing.push('refs');
  if (model.refs?.validity !== 'until-navigation-or-dom-rewrite') missing.push('refs.validity');
  const nodes = Array.isArray(model.nodes) ? model.nodes : [];
  if (!nodes.some(node => /^@[\w:-]+$/.test(String(node?.ref || '')))) missing.push('nodes.ref');
  if (!model.limits || typeof model.limits !== 'object') missing.push('limits');
  if (!recommendationHasActionableContext(model.recommendation)) missing.push('recommendation');
  const nextSteps = Array.isArray(model.nextSteps) ? model.nextSteps : [];
  if (!nextSteps.some(value => /^cdp\s+\S+/.test(String(value || '')))) missing.push('nextSteps');
  return [...new Set(missing)];
}

function benchmarkPerceptionSignalCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (model?.schema !== 'chrome-cdp-ex.perceive.v1') continue;
    total += 1;
    const missingFields = perceptionSignalMissingFields(model);
    if (missingFields.length === 0) {
      covered += 1;
    } else {
      missing.push({
        name: step.name,
        commandText: step.commandText,
        missing: missingFields,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    rate: total > 0 ? covered / total : null,
  };
}

function isSinceActionEvidenceStep(step = {}, model = {}) {
  return model?.schema === 'chrome-cdp-ex.perceive-diff.v1'
    && (model.mode === 'since-action'
      || step.name === 'since-action'
      || (Array.isArray(step.command) && step.command.includes('--since-action')));
}

function sinceActionEvidenceMissingFields(model = {}) {
  const missing = [];
  if (model.mode !== 'since-action') missing.push('mode');
  if (model.baselineAvailable === false) missing.push('baselineAvailable');
  const summary = model.summary || {};
  if (!summary || typeof summary !== 'object') {
    missing.push('summary');
  }
  if (typeof summary.changed !== 'boolean') missing.push('summary.changed');
  for (const field of ['removed', 'added', 'textRemoved', 'textAdded']) {
    if (!Number.isFinite(summary[field])) missing.push(`summary.${field}`);
  }

  const changedCounts = ['removed', 'added', 'textRemoved', 'textAdded']
    .some(field => Number.isFinite(summary[field]) && summary[field] > 0);
  const hasEvidenceSamples = ['removed', 'added', 'textRemovedSamples', 'textAddedSamples']
    .some(field => Array.isArray(model[field]) && model[field].length > 0);
  if (summary.changed === true && !changedCounts && !hasEvidenceSamples) {
    missing.push('evidence');
  }

  if (!recommendationHasActionableContext(model.recommendation)) missing.push('recommendation');
  const nextSteps = Array.isArray(model.nextSteps) ? model.nextSteps : [];
  if (!nextSteps.some(value => /^cdp\s+\S+/.test(String(value || '')))) missing.push('nextSteps');
  return [...new Set(missing)];
}

function benchmarkSinceActionEvidenceCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (!isSinceActionEvidenceStep(step, model)) continue;
    total += 1;
    const missingFields = sinceActionEvidenceMissingFields(model);
    if (missingFields.length === 0) {
      covered += 1;
    } else {
      missing.push({
        name: step.name,
        commandText: step.commandText,
        missing: missingFields,
      });
    }
  }
  return {
    total,
    covered,
    missing,
    rate: total > 0 ? covered / total : null,
  };
}

function countsTowardUsefulObservationTokens(step) {
  const model = stepModel(step);
  const commandName = normalizeActionCommandName(step.command?.[0] || step.name);
  if (commandName === 'report' || model?.schema === 'chrome-cdp-ex.report.v1') return false;
  if (MUTATING_COMMANDS.has(commandName) || model?.schema === 'chrome-cdp-ex.action.v1') return false;
  return step.hasUsefulObservation;
}

const DEFAULT_GATE_LIMITS = Object.freeze({
  commandCallsMax: 23,
  firstUsefulObservationMsMax: 5000,
  goldenPathMsMax: 120000,
  usefulObservationTokensMax: 3000,
  autoEvidenceActionsMin: 1,
  observedActionEvidenceCoverageRateMin: 1,
  actionEvidenceCompletenessCoverageRateMin: 1,
  actionFailureDiagnosisCoverageRateMin: 1,
  cliRecoveryCoverageRateMin: 1,
  handoffNextStepsCoverageRateMin: 1,
  handoffRecommendationCoverageRateMin: 1,
  doctorOnboardingCoverageRateMin: 1,
  targetHandoffCoverageRateMin: 1,
  reportLatestActionCoverageRateMin: 1,
  reportTimelineWindowCoverageRateMin: 1,
  reportArtifactCoverageRateMin: 1,
  perceptionSignalCoverageRateMin: 1,
  sinceActionEvidenceCoverageRateMin: 1,
  differentiatorSuccessRateMin: 1,
  differentiatorHandoffCoverageRateMin: 1,
  staleRefRecoveryRateMin: 1,
});

const DEFAULT_COMPARISON_BASELINE_SET = Object.freeze({
  source: 'heuristic-smoke-baseline',
  note: 'Baselines are conservative planning estimates for this smoke path until competitor harnesses are implemented.',
  baselines: Object.freeze([
    {
      id: 'playwright',
      label: 'Playwright test generator/snapshot',
      metrics: {
        commandCalls: 26,
        usefulObservationTokens: 5000,
        verificationCallsSaved: 0,
        differentiatorSuccessRate: 0.5,
      },
    },
    {
      id: 'devtools-manual',
      label: 'Manual DevTools inspection',
      metrics: {
        commandCalls: 35,
        usefulObservationTokens: null,
        verificationCallsSaved: 0,
        differentiatorSuccessRate: 0.5,
      },
    },
    {
      id: 'generic-cdp',
      label: 'Generic CDP script',
      metrics: {
        commandCalls: 30,
        usefulObservationTokens: 7000,
        verificationCallsSaved: 0,
        differentiatorSuccessRate: 0.25,
      },
    },
  ]),
});

function gateCriterion({ name, actual, operator, limit, recommendation }) {
  let passed = false;
  if (operator === '<=') passed = actual !== null && actual !== undefined && actual <= limit;
  if (operator === '>=') passed = actual !== null && actual !== undefined && actual >= limit;
  if (operator === '===') passed = actual === limit;
  return { name, passed, actual, operator, limit, recommendation };
}

export function buildBenchmarkGate(summary, limits = DEFAULT_GATE_LIMITS) {
  const metrics = summary.metrics || {};
  const differentiators = metrics.differentiators || {};
  const staleRefRecovery = metrics.staleRefRecovery || {};
  const criteria = [
    gateCriterion({
      name: 'run-success',
      actual: summary.success === true,
      operator: '===',
      limit: true,
      recommendation: 'Fix the failed benchmark step before using this run as evidence.',
    }),
    gateCriterion({
      name: 'command-calls',
      actual: metrics.commandCalls ?? null,
      operator: '<=',
      limit: limits.commandCallsMax,
      recommendation: 'Keep the Killer Path compact; use JSON handoffs and action evidence instead of extra verify calls.',
    }),
    gateCriterion({
      name: 'first-useful-observation',
      actual: metrics.firstUsefulObservationMs ?? null,
      operator: '<=',
      limit: limits.firstUsefulObservationMsMax,
      recommendation: 'Get the first useful page observation from doctor/list/open/perceive within the onboarding budget.',
    }),
    gateCriterion({
      name: 'golden-path-under-two-minutes',
      actual: metrics.goldenPathMs ?? null,
      operator: '<=',
      limit: limits.goldenPathMsMax,
      recommendation: 'Complete doctor/list/perceive/action/report within the two-minute first-success budget.',
    }),
    gateCriterion({
      name: 'useful-observation-tokens',
      actual: metrics.usefulObservationTokens ?? null,
      operator: '<=',
      limit: limits.usefulObservationTokensMax,
      recommendation: 'Reduce page observation tokens by tightening perceive output and preserving only actionable context.',
    }),
    gateCriterion({
      name: 'auto-evidence-actions',
      actual: metrics.autoEvidenceActions ?? null,
      operator: '>=',
      limit: limits.autoEvidenceActionsMin,
      recommendation: 'Make mutating commands return action evidence so agents do not need manual verification calls.',
    }),
    gateCriterion({
      name: 'observed-action-evidence-coverage',
      actual: metrics.actionEvidenceCoverage?.rate ?? null,
      operator: '>=',
      limit: limits.observedActionEvidenceCoverageRateMin,
      recommendation: 'Every mutating command exercised by the benchmark must return action evidence.',
    }),
    gateCriterion({
      name: 'action-evidence-completeness',
      actual: metrics.actionEvidenceCompletenessCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.actionEvidenceCompletenessCoverageRateMin,
      recommendation: 'Action JSON evidence must include action, target, dispatch, settle, effects deltas, outcome, and verdict so agents can decide without another perceive.',
    }),
    gateCriterion({
      name: 'action-failure-diagnosis',
      actual: metrics.actionFailureDiagnosisCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.actionFailureDiagnosisCoverageRateMin,
      recommendation: 'Failed action JSON must classify the failure and expose diagnosis recovery commands so agents can recover without parsing text.',
    }),
    gateCriterion({
      name: 'cli-recovery-coverage',
      actual: metrics.cliRecoveryCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.cliRecoveryCoverageRateMin,
      recommendation: 'Every failed benchmark step must expose an executable recovery command through Next:, Run:, or JSON nextSteps.',
    }),
    gateCriterion({
      name: 'handoff-next-steps-coverage',
      actual: metrics.handoffNextStepsCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.handoffNextStepsCoverageRateMin,
      recommendation: 'Every versioned JSON handoff in the Killer Path must expose executable top-level nextSteps.',
    }),
    gateCriterion({
      name: 'handoff-recommendation-coverage',
      actual: metrics.handoffRecommendationCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.handoffRecommendationCoverageRateMin,
      recommendation: 'Every versioned JSON handoff must expose a recommendation that explains the next action.',
    }),
    gateCriterion({
      name: 'doctor-onboarding',
      actual: metrics.doctorOnboardingCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.doctorOnboardingCoverageRateMin,
      recommendation: 'Doctor JSON must expose wizard currentStep, golden path, and readiness checks for first-run onboarding.',
    }),
    gateCriterion({
      name: 'target-handoff-coverage',
      actual: metrics.targetHandoffCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.targetHandoffCoverageRateMin,
      recommendation: 'List/open JSON must expose a concrete target prefix and an executable perceive next step so first-run agents can continue the golden path.',
    }),
    gateCriterion({
      name: 'report-timeline',
      actual: metrics.hasReportTimeline === true,
      operator: '===',
      limit: true,
      recommendation: 'Run cdp report <target> after action evidence so the session can be handed off.',
    }),
    gateCriterion({
      name: 'report-latest-action',
      actual: metrics.reportLatestActionCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.reportLatestActionCoverageRateMin,
      recommendation: 'JSON report handoffs with actions must expose latestAction so agents can resume without rescanning the timeline.',
    }),
    gateCriterion({
      name: 'report-timeline-window',
      actual: metrics.reportTimelineWindowCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.reportTimelineWindowCoverageRateMin,
      recommendation: 'JSON report handoffs must expose bounded timelineWindow metadata so long sessions stay token-safe.',
    }),
    gateCriterion({
      name: 'report-artifact-coverage',
      actual: metrics.reportArtifactCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.reportArtifactCoverageRateMin,
      recommendation: 'Report JSON must expose session log path, screenshot directory, counts, action evidence, environment, recommendation, and nextSteps so long sessions can be handed off.',
    }),
    gateCriterion({
      name: 'perception-signal-coverage',
      actual: metrics.perceptionSignalCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.perceptionSignalCoverageRateMin,
      recommendation: 'Perceive JSON must expose page, viewport, console, refs, interactive nodes, limits, recommendation, and nextSteps so agents can choose an action without another page read.',
    }),
    gateCriterion({
      name: 'since-action-evidence-coverage',
      actual: metrics.sinceActionEvidenceCoverage?.rate ?? null,
      operator: '>=',
      limit: limits.sinceActionEvidenceCoverageRateMin,
      recommendation: 'Since-action JSON must expose a causal diff summary, bounded evidence samples, recommendation, and nextSteps so agents know what changed after the action.',
    }),
    gateCriterion({
      name: 'differentiator-success-rate',
      actual: differentiators.successRate ?? 0,
      operator: '>=',
      limit: limits.differentiatorSuccessRateMin,
      recommendation: 'Keep modal/overlay, frame refs, CSS trace, and HMR/SPAs green before making differentiation claims.',
    }),
    gateCriterion({
      name: 'differentiator-handoff-coverage',
      actual: metrics.differentiatorHandoffCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.differentiatorHandoffCoverageRateMin,
      recommendation: 'Keep overlay and frame JSON probes agent-readable before making differentiation claims.',
    }),
    gateCriterion({
      name: 'stale-ref-recovery-rate',
      actual: staleRefRecovery.rate ?? 0,
      operator: '>=',
      limit: limits.staleRefRecoveryRateMin,
      recommendation: 'Classify stale refs with an executable perceive recovery command.',
    }),
    gateCriterion({
      name: 'session-stability-sample',
      actual: metrics.sessionStability?.success === true,
      operator: '===',
      limit: true,
      recommendation: 'Run the stability wait/status/report probe, or use --stability-ms for a longer dogfood window.',
    }),
  ];
  const passedCount = criteria.filter(criterion => criterion.passed).length;
  return {
    schema: 'chrome-cdp-ex.benchmark-gate.v1',
    profile: 'killer-path-default',
    passed: passedCount === criteria.length,
    passedCount,
    total: criteria.length,
    criteria,
  };
}

function normalizeBaselineMetrics(metrics = {}) {
  const normalized = {
    commandCalls: metrics.commandCalls ?? null,
    usefulObservationTokens: metrics.usefulObservationTokens ?? null,
    verificationCallsSaved: metrics.verificationCallsSaved ?? 0,
    differentiatorSuccessRate: metrics.differentiatorSuccessRate ?? null,
  };
  if (Object.hasOwn(metrics, 'autoEvidenceActions')) {
    normalized.autoEvidenceActions = metrics.autoEvidenceActions ?? null;
  }
  if (Object.hasOwn(metrics, 'hasReportTimeline')) {
    normalized.hasReportTimeline = metrics.hasReportTimeline;
  }
  if (Object.hasOwn(metrics, 'staleRefRecoveryRate')) {
    normalized.staleRefRecoveryRate = metrics.staleRefRecoveryRate ?? null;
  }
  if (Object.hasOwn(metrics, 'sessionStabilitySample')) {
    normalized.sessionStabilitySample = metrics.sessionStabilitySample;
  }
  return normalized;
}

function normalizeComparisonBaselineSet(input = DEFAULT_COMPARISON_BASELINE_SET) {
  if (Array.isArray(input)) {
    return { ...DEFAULT_COMPARISON_BASELINE_SET, baselines: input };
  }
  return {
    source: input.source || DEFAULT_COMPARISON_BASELINE_SET.source,
    note: input.note || DEFAULT_COMPARISON_BASELINE_SET.note,
    baselines: Array.isArray(input.baselines) ? input.baselines : DEFAULT_COMPARISON_BASELINE_SET.baselines,
  };
}

export function loadComparisonBaselineFile(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (parsed.schema !== 'chrome-cdp-ex.comparison-baselines.v1') {
    throw new Error(`comparison baseline file must use schema chrome-cdp-ex.comparison-baselines.v1: ${filePath}`);
  }
  if (!Array.isArray(parsed.baselines)) {
    throw new Error(`comparison baseline file must include baselines array: ${filePath}`);
  }
  return {
    source: parsed.source || 'measured-baseline-file',
    note: parsed.note || `Measured comparison baselines loaded from ${filePath}.`,
    baselines: parsed.baselines.map((baseline, index) => ({
      id: baseline.id || `baseline-${index + 1}`,
      label: baseline.label || baseline.id || `Baseline ${index + 1}`,
      metrics: normalizeBaselineMetrics(baseline.metrics || {}),
    })),
  };
}

export function buildBenchmarkComparison(summary, baselineSet = DEFAULT_COMPARISON_BASELINE_SET) {
  const normalizedBaselineSet = normalizeComparisonBaselineSet(baselineSet);
  const actual = summary.metrics || {};
  const actualDifferentiatorRate = actual.differentiators?.successRate ?? 0;
  const actualMetrics = {
    commandCalls: actual.commandCalls ?? null,
    usefulObservationTokens: actual.usefulObservationTokens ?? null,
    verificationCallsSaved: actual.verificationCallsSaved ?? null,
    differentiatorSuccessRate: actualDifferentiatorRate,
    autoEvidenceActions: actual.autoEvidenceActions ?? null,
    hasReportTimeline: actual.hasReportTimeline ?? null,
    staleRefRecoveryRate: actual.staleRefRecovery?.rate ?? null,
    sessionStabilitySample: actual.sessionStability?.success ?? null,
  };
  return {
    schema: 'chrome-cdp-ex.benchmark-comparison.v1',
    source: normalizedBaselineSet.source,
    note: normalizedBaselineSet.note,
    actual: actualMetrics,
    baselines: normalizedBaselineSet.baselines.map((baseline) => {
      const metrics = normalizeBaselineMetrics(baseline.metrics);
      const capabilityGaps = [];
      if (metrics.autoEvidenceActions != null && actualMetrics.autoEvidenceActions != null && metrics.autoEvidenceActions < actualMetrics.autoEvidenceActions) {
        capabilityGaps.push('action-evidence');
      }
      if (metrics.hasReportTimeline === false && actualMetrics.hasReportTimeline === true) {
        capabilityGaps.push('report-timeline');
      }
      if (metrics.staleRefRecoveryRate != null && actualMetrics.staleRefRecoveryRate != null && metrics.staleRefRecoveryRate < actualMetrics.staleRefRecoveryRate) {
        capabilityGaps.push('stale-ref-recovery');
      }
      if (metrics.sessionStabilitySample === false && actualMetrics.sessionStabilitySample === true) {
        capabilityGaps.push('session-stability');
      }
      return {
        id: baseline.id,
        label: baseline.label,
        metrics,
        capabilityGaps,
        delta: {
          commandCallsSaved: metrics.commandCalls != null && actual.commandCalls != null
            ? metrics.commandCalls - actual.commandCalls
            : null,
          usefulObservationTokensSaved: metrics.usefulObservationTokens != null && actual.usefulObservationTokens != null
            ? metrics.usefulObservationTokens - actual.usefulObservationTokens
            : null,
          verificationCallsSaved: actual.verificationCallsSaved != null
            ? actual.verificationCallsSaved - (metrics.verificationCallsSaved || 0)
            : null,
          differentiatorSuccessRateDelta: metrics.differentiatorSuccessRate != null
            ? actualDifferentiatorRate - metrics.differentiatorSuccessRate
            : null,
        },
      };
    }),
  };
}

export function summarizeBenchmarkRun({ scenario = 'killer-path', startedAt, endedAt, target = '', steps = [], comparisonBaselineSet = DEFAULT_COMPARISON_BASELINE_SET } = {}) {
  const normalizedSteps = steps.map((step) => {
    const text = outputText(step);
    const model = parseJsonOutput(text);
    const outputChars = text.length;
    const baseStep = { ...step, outputText: text, model };
    const actionEvidence = hasActionEvidence(baseStep);
    const expectedFailure = Boolean(step.expectedFailure);
    return {
      name: step.name,
      command: step.command || [],
      commandText: `cdp ${(step.command || []).join(' ')}`.trim(),
      ok: step.status === 0 || expectedFailure,
      status: step.status,
      expectedFailure,
      benchmarkProbe: Boolean(step.benchmarkProbe),
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      durationMs: Math.max(0, (step.endedAt ?? step.startedAt ?? 0) - (step.startedAt ?? 0)),
      outputChars,
      estimatedTokens: estimateTokenCount(outputChars),
      hasUsefulObservation: hasUsefulObservation(baseStep),
      hasActionEvidence: actionEvidence,
      outputText: text,
      model,
    };
  });

  const coreSteps = normalizedSteps.filter(step => !step.benchmarkProbe);
  const firstObservation = coreSteps.find(step => step.ok && step.hasUsefulObservation);
  const failed = normalizedSteps.find(step => !step.ok);
  const outputChars = normalizedSteps.reduce((sum, step) => sum + step.outputChars, 0);
  const actionEvidenceSteps = coreSteps.filter(step => step.hasActionEvidence && !step.expectedFailure);
  const usefulObservationTokens = coreSteps
    .filter(countsTowardUsefulObservationTokens)
    .reduce((sum, step) => sum + step.estimatedTokens, 0);
  const reportStep = coreSteps.find(step => step.name === 'report') || null;
  const firstActionEvidence = actionEvidenceSteps[0] || null;

  const summary = {
    schema: 'chrome-cdp-ex.benchmark.v1',
    scenario,
    target,
    success: !failed,
    failedStep: failed?.name || null,
    metrics: {
      totalMs: Math.max(0, (endedAt ?? startedAt ?? 0) - (startedAt ?? 0)),
      commandCalls: coreSteps.length,
      firstUsefulObservationMs: firstObservation
        ? Math.max(0, (firstObservation.endedAt ?? endedAt ?? 0) - (startedAt ?? 0))
        : null,
      firstActionEvidenceMs: firstActionEvidence
        ? Math.max(0, (firstActionEvidence.endedAt ?? endedAt ?? 0) - (startedAt ?? 0))
        : null,
      goldenPathMs: reportStep && hasReportTimeline(reportStep)
        ? Math.max(0, (reportStep.endedAt ?? endedAt ?? 0) - (startedAt ?? 0))
        : null,
      outputChars,
      estimatedOutputTokens: estimateTokenCount(outputChars),
      usefulObservationTokens,
      autoEvidenceActions: actionEvidenceSteps.length,
      actionEvidenceCoverage: benchmarkActionEvidenceCoverage(normalizedSteps),
      actionEvidenceCompletenessCoverage: benchmarkActionEvidenceCompletenessCoverage(normalizedSteps),
      actionFailureDiagnosisCoverage: benchmarkActionFailureDiagnosisCoverage(normalizedSteps),
      cliRecoveryCoverage: benchmarkCliRecoveryCoverage(normalizedSteps),
      handoffNextStepsCoverage: benchmarkHandoffNextStepsCoverage(normalizedSteps),
      handoffRecommendationCoverage: benchmarkHandoffRecommendationCoverage(normalizedSteps),
      doctorOnboardingCoverage: benchmarkDoctorOnboardingCoverage(normalizedSteps),
      targetHandoffCoverage: benchmarkTargetHandoffCoverage(normalizedSteps),
      reportLatestActionCoverage: benchmarkReportLatestActionCoverage(normalizedSteps),
      reportTimelineWindowCoverage: benchmarkReportTimelineWindowCoverage(normalizedSteps),
      reportArtifactCoverage: benchmarkReportArtifactCoverage(normalizedSteps),
      perceptionSignalCoverage: benchmarkPerceptionSignalCoverage(normalizedSteps),
      sinceActionEvidenceCoverage: benchmarkSinceActionEvidenceCoverage(normalizedSteps),
      verificationCallsSaved: actionEvidenceSteps.length,
      hasReportTimeline: hasReportTimeline(reportStep || {}),
      differentiators: benchmarkDifferentiators(normalizedSteps),
      differentiatorHandoffCoverage: benchmarkDifferentiatorHandoffCoverage(normalizedSteps),
      staleRefRecovery: benchmarkStaleRefRecovery(normalizedSteps),
      sessionStability: benchmarkSessionStability(normalizedSteps),
    },
    steps: normalizedSteps.map(({ outputText: _outputText, model: _model, ...step }) => step),
  };
  summary.gate = buildBenchmarkGate(summary);
  summary.comparison = buildBenchmarkComparison(summary, comparisonBaselineSet);
  return summary;
}

function formatSignedDelta(value, unit) {
  if (value == null) return `unknown ${unit}`;
  if (value >= 0) return `saves ${value} ${unit}`;
  return `costs ${Math.abs(value)} ${unit}`;
}

export function formatBenchmarkReport(summary) {
  const differentiators = summary.metrics.differentiators || {};
  const pct = Math.round((differentiators.successRate || 0) * 100);
  const gate = summary.gate || buildBenchmarkGate(summary);
  const failedGateCriteria = gate.criteria.filter(criterion => !criterion.passed);
  const lines = [
    `chrome-cdp-ex benchmark: ${summary.scenario}`,
    `Success: ${summary.success ? 'yes' : 'no'}${summary.failedStep ? ` (failed at ${summary.failedStep})` : ''}`,
    `Target: ${summary.target || '(none)'}`,
    `Total time: ${summary.metrics.totalMs} ms`,
    `Command calls: ${summary.metrics.commandCalls}`,
    `First useful observation: ${summary.metrics.firstUsefulObservationMs ?? 'n/a'} ms`,
    `First action evidence: ${summary.metrics.firstActionEvidenceMs ?? 'n/a'} ms`,
    `Golden path complete: ${summary.metrics.goldenPathMs ?? 'n/a'} ms`,
    `Output chars: ${summary.metrics.outputChars}`,
    `Estimated output tokens: ${summary.metrics.estimatedOutputTokens}`,
    `Useful observation tokens: ${summary.metrics.usefulObservationTokens}`,
    `Auto-evidence actions: ${summary.metrics.autoEvidenceActions}`,
    `Action evidence coverage: ${summary.metrics.actionEvidenceCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.actionEvidenceCoverage.rate * 100)}%`} (${summary.metrics.actionEvidenceCoverage?.covered ?? 0}/${summary.metrics.actionEvidenceCoverage?.total ?? 0})`,
    `Action evidence completeness: ${summary.metrics.actionEvidenceCompletenessCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.actionEvidenceCompletenessCoverage.rate * 100)}%`} (${summary.metrics.actionEvidenceCompletenessCoverage?.covered ?? 0}/${summary.metrics.actionEvidenceCompletenessCoverage?.total ?? 0})`,
    `Action failure diagnosis coverage: ${summary.metrics.actionFailureDiagnosisCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.actionFailureDiagnosisCoverage.rate * 100)}%`} (${summary.metrics.actionFailureDiagnosisCoverage?.covered ?? 0}/${summary.metrics.actionFailureDiagnosisCoverage?.total ?? 0})`,
    `CLI recovery coverage: ${summary.metrics.cliRecoveryCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.cliRecoveryCoverage.rate * 100)}%`} (${summary.metrics.cliRecoveryCoverage?.covered ?? 0}/${summary.metrics.cliRecoveryCoverage?.total ?? 0})`,
    `Handoff nextSteps coverage: ${summary.metrics.handoffNextStepsCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.handoffNextStepsCoverage.rate * 100)}%`} (${summary.metrics.handoffNextStepsCoverage?.covered ?? 0}/${summary.metrics.handoffNextStepsCoverage?.total ?? 0})`,
    `Handoff recommendation coverage: ${summary.metrics.handoffRecommendationCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.handoffRecommendationCoverage.rate * 100)}%`} (${summary.metrics.handoffRecommendationCoverage?.covered ?? 0}/${summary.metrics.handoffRecommendationCoverage?.total ?? 0})`,
    `Doctor onboarding coverage: ${summary.metrics.doctorOnboardingCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.doctorOnboardingCoverage.rate * 100)}%`} (${summary.metrics.doctorOnboardingCoverage?.covered ?? 0}/${summary.metrics.doctorOnboardingCoverage?.total ?? 0})`,
    `Target handoff coverage: ${summary.metrics.targetHandoffCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.targetHandoffCoverage.rate * 100)}%`} (${summary.metrics.targetHandoffCoverage?.covered ?? 0}/${summary.metrics.targetHandoffCoverage?.total ?? 0})`,
    `Report latestAction coverage: ${summary.metrics.reportLatestActionCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.reportLatestActionCoverage.rate * 100)}%`} (${summary.metrics.reportLatestActionCoverage?.covered ?? 0}/${summary.metrics.reportLatestActionCoverage?.total ?? 0})`,
    `Report timelineWindow coverage: ${summary.metrics.reportTimelineWindowCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.reportTimelineWindowCoverage.rate * 100)}%`} (${summary.metrics.reportTimelineWindowCoverage?.covered ?? 0}/${summary.metrics.reportTimelineWindowCoverage?.total ?? 0})`,
    `Report artifact coverage: ${summary.metrics.reportArtifactCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.reportArtifactCoverage.rate * 100)}%`} (${summary.metrics.reportArtifactCoverage?.covered ?? 0}/${summary.metrics.reportArtifactCoverage?.total ?? 0})`,
    `Perception signal coverage: ${summary.metrics.perceptionSignalCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.perceptionSignalCoverage.rate * 100)}%`} (${summary.metrics.perceptionSignalCoverage?.covered ?? 0}/${summary.metrics.perceptionSignalCoverage?.total ?? 0})`,
    `Since-action evidence coverage: ${summary.metrics.sinceActionEvidenceCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.sinceActionEvidenceCoverage.rate * 100)}%`} (${summary.metrics.sinceActionEvidenceCoverage?.covered ?? 0}/${summary.metrics.sinceActionEvidenceCoverage?.total ?? 0})`,
    `Differentiator handoff coverage: ${summary.metrics.differentiatorHandoffCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.differentiatorHandoffCoverage.rate * 100)}%`} (${summary.metrics.differentiatorHandoffCoverage?.covered ?? 0}/${summary.metrics.differentiatorHandoffCoverage?.total ?? 0})`,
    `Verification calls saved: ${summary.metrics.verificationCallsSaved}`,
    `Report timeline: ${summary.metrics.hasReportTimeline ? 'yes' : 'no'}`,
    `Quality gate: ${gate.passed ? 'pass' : 'fail'}`,
    `Gate checks: ${gate.passedCount}/${gate.total} pass`,
    `Differentiator success rate: ${pct}%`,
    `Modal/overlay: ${differentiators.modalOverlay?.success ? 'yes' : 'no'} (${differentiators.modalOverlay?.durationMs ?? 0} ms)`,
    `Frame refs: ${differentiators.frameRefs?.success ? 'yes' : 'no'} (${differentiators.frameRefs?.durationMs ?? 0} ms)`,
    `CSS trace: ${differentiators.cssTrace?.success ? 'yes' : 'no'} (${differentiators.cssTrace?.durationMs ?? 0} ms)`,
    `HMR/SPA diff: ${differentiators.hmrDomUpdate?.success ? 'yes' : 'no'} (${differentiators.hmrDomUpdate?.durationMs ?? 0} ms)`,
    `Stale-ref recovery: ${summary.metrics.staleRefRecovery?.success ? 'yes' : 'no'} (${summary.metrics.staleRefRecovery?.recovered ?? 0}/${summary.metrics.staleRefRecovery?.commandCalls ?? 0})`,
    summary.metrics.sessionStability?.enabled
      ? `Session stability: ${summary.metrics.sessionStability.success ? 'yes' : 'no'} (${summary.metrics.sessionStability.durationMs} ms, ${summary.metrics.sessionStability.commandCalls} probes)`
      : 'Session stability: not measured',
    '',
  ];
  if (failedGateCriteria.length) {
    lines.push('Gate failures:');
    for (const criterion of failedGateCriteria) {
      lines.push(`  - ${criterion.name}: actual ${criterion.actual} ${criterion.operator} ${criterion.limit} (${criterion.recommendation})`);
    }
    lines.push('');
  }
  if (summary.comparison?.baselines?.length) {
    lines.push(`Comparison baselines: ${summary.comparison.source}`);
    for (const baseline of summary.comparison.baselines) {
      const calls = formatSignedDelta(baseline.delta.commandCallsSaved, 'calls');
      const tokens = formatSignedDelta(baseline.delta.usefulObservationTokensSaved, 'useful-observation tokens');
      const verify = formatSignedDelta(baseline.delta.verificationCallsSaved, 'verification calls');
      const gaps = baseline.capabilityGaps?.length ? `, gaps: ${baseline.capabilityGaps.join(', ')}` : '';
      lines.push(`  - ${baseline.label}: ${calls}, ${tokens}, ${verify}${gaps}`);
    }
    lines.push('');
  }
  lines.push('Steps:');
  for (const step of summary.steps) {
    const details = [
      step.hasActionEvidence ? 'evidence' : '',
      step.expectedFailure ? 'expected failure' : '',
    ].filter(Boolean).join(', ');
    const suffix = details ? `, ${details}` : '';
    lines.push(`  ${step.ok ? 'OK  ' : 'FAIL'} ${step.name}: ${step.durationMs} ms, ${step.estimatedTokens} tokens${suffix}`);
  }
  return lines.join('\n');
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

function runStep({ args, env, steps, name = args[0], timeout = 20000, expectedFailure = false, benchmarkProbe = false }) {
  const startedAt = Date.now();
  return new Promise((resolveStep) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let spawnError = null;
    const child = spawn(process.execPath, [cdp, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const endedAt = Date.now();
      const step = {
        name,
        command: args,
        startedAt,
        endedAt,
        status: status ?? (signal ? 1 : 0),
        signal: signal || null,
        error: spawnError?.message || (timedOut ? `spawn ${process.execPath} ETIMEDOUT` : null),
        expectedFailure,
        benchmarkProbe,
        stdout,
        stderr,
      };
      steps.push(step);
      resolveStep(step);
    };
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      spawnError = error;
      finish(1, null);
    });
    child.on('close', finish);
  });
}

function benchmarkHashUrl(baseUrl, hash) {
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  url.hash = hash;
  return url.toString();
}

export function buildKillerPathEntryPlan(url) {
  return [
    { args: ['doctor', '--format', 'json'] },
    { args: ['open', url, '--attach-timeout-ms', '5000', '--ready-timeout-ms', '5000', '--ready-selector', '#custom-clickable', '--format', 'json'], timeout: 40000 },
    { args: ['list', '--format', 'json'], requiresOpenedTarget: true, benchmarkProbe: true },
  ];
}

export function buildKillerPathBenchmarkPlan(target, { stabilityMs = 1000, entrySteps = 'doctor-list', navUrl = null } = {}) {
  const hmrMutationScript = '(() => { if (typeof appendLog === "function") { appendLog("hmr panel ready"); return "hmr-added"; } const log = document.querySelector("#combat-log"); const el = document.createElement("p"); el.id = "hmr-panel"; el.textContent = "hmr panel ready"; log?.appendChild(el); if (log) log.scrollTop = log.scrollHeight; return "hmr-added"; })()';
  const actionEvidenceNavUrl = benchmarkHashUrl(navUrl, 'after-action-evidence');
  const plan = [];
  if (entrySteps === 'doctor-list') {
    plan.push(
      { args: ['doctor', '--format', 'json'] },
      { args: ['list', '--format', 'json'] },
    );
  } else if (entrySteps !== 'none') {
    throw new Error(`Unknown benchmark entrySteps: ${entrySteps}`);
  }
  plan.push(
    { args: ['perceive', target, '-C', '-d', '8', '--keep-refs', '--last', '20', '--format', 'json'] },
    { args: ['overlay', target] },
    { args: ['overlay', target, '--format', 'json'], name: 'overlay-json', benchmarkProbe: true },
    { args: ['frame', target] },
    { args: ['frame', target, '--format', 'json'], name: 'frame-json', benchmarkProbe: true },
    { args: ['cascade', target, '#custom-clickable', 'cursor'] },
    { args: ['dismiss-modal', target, '--format', 'json'] },
    { args: ['fill', target, '#cmd', 'look trainer', '--format', 'json'] },
    { args: ['click', target, '#combat', '--format', 'json'] },
    { args: ['perceive', target, '--since-action', '--format', 'json'] },
    { args: ['report', target, '--format', 'json'] },
    { args: ['perceive', target, '-s', '#combat-log', '-d', '6', '--last', '20'], name: 'hmr-baseline' },
    { args: ['eval', target, hmrMutationScript], name: 'hmr-mutate' },
    { args: ['perceive', target, '--diff', '-s', '#combat-log', '-d', '6', '--last', '20'], name: 'hmr-diff' },
    { args: ['inject', target, '--css', '#combat-log { outline: 2px solid rgb(37, 99, 235); }', '--format', 'json'] },
    ...(actionEvidenceNavUrl ? [{ args: ['nav', target, actionEvidenceNavUrl, '--format', 'json'] }] : []),
    { args: ['perceive', target, '-s', '#cmd', '-d', '4'], name: 'stale-ref-setup' },
    { args: ['reload', target, '--format', 'json'], name: 'stale-ref-mutate' },
    { args: ['wait', target, '1000'], name: 'stale-ref-wait', timeout: 5000 },
    {
      args: ['click', target, '@1'],
      name: 'stale-ref',
      expectedFailure: true,
      expectedPattern: /Action failure: stale-ref|Unknown ref|Refs were (cleared|invalidated)|Next:\s*cdp perceive/i,
    },
    {
      args: ['click', target, '@1', '--format', 'json'],
      name: 'stale-ref-json',
      benchmarkProbe: true,
    },
  );
  if (stabilityMs > 0) {
    plan.push(
      {
        args: ['wait', target, String(stabilityMs)],
        name: 'stability-wait',
        timeout: Math.max(5000, stabilityMs + 5000),
      },
      { args: ['status', target], name: 'stability-status' },
      { args: ['report', target], name: 'stability-report' },
    );
  }
  return plan;
}

function assertStep(step) {
  if (step.status !== 0) {
    const diagnostics = [
      `status: ${step.status}`,
      step.signal ? `signal: ${step.signal}` : null,
      step.error ? `error: ${step.error}` : null,
    ].filter(Boolean).join('\n');
    throw new Error(`cdp ${step.command.join(' ')} failed\n${diagnostics}\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
  }
  return step.stdout.trim();
}

function assertExpectedFailure(step, pattern) {
  if (step.status === 0) {
    throw new Error(`cdp ${step.command.join(' ')} should have failed\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
  }
  const text = outputText(step);
  if (pattern && !pattern.test(text)) {
    throw new Error(`cdp ${step.command.join(' ')} failed without expected recovery evidence\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
  }
  return text.trim();
}

export function parseBenchmarkArgs(argv = []) {
  const opts = { json: false, stabilityMs: 1000, comparisonBaselinesPath: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') {
      opts.json = true;
    } else if (argv[i] === '--stability-ms') {
      const value = Number(argv[++i]);
      opts.stabilityMs = Number.isFinite(value) && value >= 0 ? value : opts.stabilityMs;
    } else if (argv[i] === '--comparison-baselines' || argv[i] === '--baseline-file') {
      opts.comparisonBaselinesPath = argv[++i] || null;
    }
  }
  return opts;
}

export async function runKillerPathBenchmark({ port = Number(process.env.CDP_BENCH_PORT || 9334), serverPort = Number(process.env.CDP_BENCH_HTTP_PORT || 41738), json = false, stabilityMs = 1000, comparisonBaselinesPath = null } = {}) {
  if (!existsSync(cdp)) throw new Error(`cdp script not found: ${cdp}`);
  if (!existsSync(page)) throw new Error(`smoke page not found: ${page}`);
  const candidates = browserCandidates();
  if (candidates.length === 0) throw new Error('no supported Chrome/Edge/Brave browser binary found');

  const [browserPath, browserName] = candidates[0];
  const profileDir = mkdtempSync(resolve(tmpdir(), `chrome-cdp-ex-bench-${browserName}-`));
  let browser;
  let server;
  const steps = [];
  const startedAt = Date.now();
  let target = '';

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
        res.end('{"ok":false,"error":"benchmark diagnostic"}');
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise((resolveServer, reject) => {
      server.once('error', reject);
      server.listen(serverPort, '127.0.0.1', resolveServer);
    });

    const url = `http://127.0.0.1:${serverPort}/smoke-page.html`;
    browser = spawn(browserPath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    browser.unref();

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

    const entrySteps = buildKillerPathEntryPlan(url);
    for (const planned of entrySteps) {
      const step = await runStep({ ...planned, env, steps });
      assertStep(step);
      if (planned.args[0] === 'open') {
        const model = parseJsonOutput(outputText(step));
        if (!model?.targetPrefix) throw new Error(`open did not return a targetPrefix\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
        if (model.attached !== true) throw new Error(`open did not attach the benchmark tab within 5000ms\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
        if (model.navigation?.ok !== true) throw new Error(`open did not navigate the benchmark tab\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
        if (model.ready?.ok !== true) throw new Error(`open did not reach the benchmark ready selector within 5000ms\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
        target = model.targetPrefix;
      } else if (planned.requiresOpenedTarget) {
        const model = parseJsonOutput(outputText(step));
        if (model?.schema !== 'chrome-cdp-ex.list.v1') throw new Error(`list did not return a JSON page handoff\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
        const missing = targetHandoffMissingFields(model);
        if (missing.length) throw new Error(`list target handoff is incomplete (${missing.join(', ')})\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
        const listedOpenedTarget = Array.isArray(model.pages) && model.pages.some(page => page?.targetPrefix === target);
        if (!listedOpenedTarget) throw new Error(`list did not include the opened benchmark target ${target}\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
        if (!hasPerceiveNextStepForTarget(model, target) || !String(model.recommendation?.run || '').startsWith(`cdp perceive ${target}`)) {
          throw new Error(`list did not recommend perceiving the opened benchmark target ${target}\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
        }
      }
    }
    if (!target) throw new Error('open did not produce a benchmark target');

    for (const planned of buildKillerPathBenchmarkPlan(target, { stabilityMs, entrySteps: 'none', navUrl: url })) {
      const step = await runStep({ ...planned, env, steps });
      if (planned.expectedFailure) {
        assertExpectedFailure(step, planned.expectedPattern);
      } else {
        assertStep(step);
      }
    }

    const summary = summarizeBenchmarkRun({
      scenario: 'killer-path',
      startedAt,
      endedAt: Date.now(),
      target,
      steps,
      comparisonBaselineSet: comparisonBaselinesPath ? loadComparisonBaselineFile(comparisonBaselinesPath) : DEFAULT_COMPARISON_BASELINE_SET,
    });
    summary.browser = browserName;
    summary.port = port;
    summary.url = url;
    return json ? JSON.stringify(summary, null, 2) : formatBenchmarkReport(summary);
  } finally {
    cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const opts = parseBenchmarkArgs(process.argv.slice(2));
  runKillerPathBenchmark(opts)
    .then(out => {
      console.log(out);
    })
    .catch(err => {
      console.error(`Benchmark failed: ${err.message || err}`);
      process.exit(1);
    });
}
