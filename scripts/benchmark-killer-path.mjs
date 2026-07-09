#!/usr/bin/env node
import { createServer } from 'http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn, spawnSync } from 'child_process';

import { withLiveBenchmarkLock } from './benchmark-run-lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cdp = resolve(repoRoot, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const page = resolve(__dirname, 'smoke-page.html');
const LARGE_APP_PERCEIVE_ARGS = Object.freeze(['-C', '-d', '3', '--keep-refs', '--last', '5', '--format', 'json']);
const ADVERSARIAL_TRAITS = Object.freeze([
  'overlay',
  'stale-ref',
  'iframe',
  'shadow-dom',
  'spa-route',
  'slow-network',
  'auth-wall',
  'large-table',
  'hidden-template',
]);

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
  const guardedPage = differentiatorProbe(steps, (step) => {
    const commandName = step.command?.[0] || step.name;
    const text = step.outputText || '';
    return (step.name === 'guarded-page' || commandName === 'perceive')
      && /auth(?:enticated)?|logged[- ]in|dashboard|guarded/i.test(text)
      && /@|button|region|status/i.test(text);
  });
  const probes = [modalOverlay, frameRefs, cssTrace, hmrDomUpdate, guardedPage];
  const successRate = probes.filter(probe => probe.success).length / probes.length;
  return { modalOverlay, frameRefs, cssTrace, hmrDomUpdate, guardedPage, successRate };
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

  if (model.schema === 'chrome-cdp-ex.cascade.v1') {
    if (!Number.isFinite(model.propertyCount)) missing.push('propertyCount');
    const properties = Array.isArray(model.properties) ? model.properties : null;
    if (!properties) missing.push('properties');
    if (!(properties || []).some(entry => typeof entry?.winner?.source === 'string' && entry.winner.source.trim())) {
      missing.push('properties.winner.source');
    }
    if (typeof model.editTarget?.source !== 'string' || !model.editTarget.source.trim()) {
      missing.push('editTarget.source');
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
    if (!['chrome-cdp-ex.overlays.v1', 'chrome-cdp-ex.frames.v1', 'chrome-cdp-ex.cascade.v1'].includes(model?.schema)) continue;
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

function benchmarkAdversarialScenario(scenario = null, steps = []) {
  if (!scenario) return { enabled: false };
  const traits = Array.isArray(scenario.traits) ? scenario.traits : [];
  const stepNames = new Set(steps.map(step => step.name));
  const exercised = {
    'slow-network': stepNames.has('adversarial-slow-network'),
    'large-table': stepNames.has('adversarial-table'),
    'shadow-dom': stepNames.has('adversarial-shadow'),
  };
  const exercisedTraits = traits.filter(trait => exercised[trait] === true);
  return {
    enabled: true,
    schema: scenario.schema || 'chrome-cdp-ex.adversarial-scenario.v1',
    seed: scenario.seed || null,
    targetClass: scenario.targetClass || null,
    traits,
    replayCommand: scenario.replayCommand || null,
    generatedCoverage: {
      total: ADVERSARIAL_TRAITS.length,
      covered: traits.filter(trait => ADVERSARIAL_TRAITS.includes(trait)).length,
      missing: ADVERSARIAL_TRAITS.filter(trait => !traits.includes(trait)),
      rate: ADVERSARIAL_TRAITS.length ? traits.filter(trait => ADVERSARIAL_TRAITS.includes(trait)).length / ADVERSARIAL_TRAITS.length : null,
    },
    exercisedCoverage: {
      total: Object.keys(exercised).filter(trait => traits.includes(trait)).length,
      covered: exercisedTraits.length,
      missing: Object.entries(exercised)
        .filter(([trait, covered]) => traits.includes(trait) && covered !== true)
        .map(([trait]) => trait),
      rate: Object.keys(exercised).some(trait => traits.includes(trait))
        ? exercisedTraits.length / Object.keys(exercised).filter(trait => traits.includes(trait)).length
        : null,
    },
    scale: {
      tableRows: scenario.tableRows ?? null,
      hiddenTemplateNodes: scenario.hiddenTemplateNodes ?? null,
      slowNetworkMs: scenario.slowNetworkMs ?? null,
    },
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

  const receipt = model.receipt || {};
  if (!Object.hasOwn(model, 'receipt') || !model.receipt || typeof model.receipt !== 'object') missing.push('receipt');
  if (typeof receipt.eventId !== 'string' || !receipt.eventId.trim()) missing.push('receipt.eventId');
  if (!receipt.dispatch || typeof receipt.dispatch !== 'object') missing.push('receipt.dispatch');
  if (!receipt.settlement || typeof receipt.settlement !== 'object') missing.push('receipt.settlement');
  const receiptSettlement = receipt.settlement || {};
  if (typeof receiptSettlement.state !== 'string' || !receiptSettlement.state.trim()) missing.push('receipt.settlement.state');
  if (typeof receiptSettlement.strategy !== 'string' || !receiptSettlement.strategy.trim()) missing.push('receipt.settlement.strategy');
  if (!Number.isFinite(receiptSettlement.durationMs)) missing.push('receipt.settlement.durationMs');
  if (!Array.isArray(receiptSettlement.signals)) missing.push('receipt.settlement.signals');
  if (!Array.isArray(receipt.observedDelta)) missing.push('receipt.observedDelta');
  if (!Array.isArray(receipt.observedDeltaDetails) || receipt.observedDeltaDetails.length === 0) missing.push('receipt.observedDeltaDetails');
  if (!Array.isArray(receipt.blockingSignals)) missing.push('receipt.blockingSignals');
  if (typeof receipt.recoveryHint !== 'string' || !receipt.recoveryHint.trim()) missing.push('receipt.recoveryHint');
  const receiptNextSteps = Array.isArray(receipt.nextSteps) ? receipt.nextSteps : [];
  if (!receiptNextSteps.some(isExecutableRecoveryCommand)) missing.push('receipt.nextSteps');
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

function isNoChangeActionModel(model = {}) {
  return model?.schema === 'chrome-cdp-ex.action.v1'
    && model.outcome?.status === 'no-change';
}

function actionNoChangeRecoveryMissingFields(model = {}) {
  const missing = [];
  const verdict = model.verdict || {};
  const recommendation = model.recommendation || {};
  const receipt = model.receipt || {};
  const blockingSignals = Array.isArray(receipt.blockingSignals) ? receipt.blockingSignals : [];
  const nextSteps = Array.isArray(model.nextSteps) ? model.nextSteps : [];
  const hasStep = (name) => nextSteps.some(value => new RegExp(`^cdp\\s+${name}\\b`).test(String(value || '')));

  if (verdict.status !== 'investigate') missing.push('verdict.status');
  if (verdict.canContinue !== false) missing.push('verdict.canContinue');
  if (verdict.needsRecovery !== true) missing.push('verdict.needsRecovery');
  if (!isExecutableRecoveryCommand(verdict.primaryNextStep)) missing.push('verdict.primaryNextStep');
  if (recommendation.strategy !== 'investigate-no-change') missing.push('recommendation.strategy');
  if (blockingSignals.includes('overlay-check-needed') && !hasStep('overlay')) missing.push('nextSteps.overlay');
  if (blockingSignals.includes('frame-check-needed') && !hasStep('frame')) missing.push('nextSteps.frame');
  if ((blockingSignals.length === 0 || blockingSignals.includes('fresh-perception-needed')) && !hasStep('perceive')) missing.push('nextSteps.perceive');
  if (!hasStep('report')) missing.push('nextSteps.report');
  if (!Array.isArray(receipt.blockingSignals) || receipt.blockingSignals.length === 0) missing.push('receipt.blockingSignals');
  if (typeof receipt.recoveryHint !== 'string' || !receipt.recoveryHint.trim()) missing.push('receipt.recoveryHint');
  return [...new Set(missing)];
}

function benchmarkActionNoChangeRecoveryCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (!isNoChangeActionModel(model)) continue;
    total += 1;
    const missingFields = actionNoChangeRecoveryMissingFields(model);
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
      const recommendedPage = pages.find(page => page?.isBlank === false && targetPrefixIsConcrete(page?.targetPrefix))
        || pages.find(page => targetPrefixIsConcrete(page?.targetPrefix));
      const firstPrefix = recommendedPage?.targetPrefix;
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

const LONG_SESSION_REPORT_ACTIONS_MIN = 50;

function reportActionHasRecoveryCriticalReceipt(action = {}) {
  const receipt = action.receipt || {};
  return receipt
    && typeof receipt === 'object'
    && (receipt.eventId || Number.isFinite(receipt.sequence))
    && receipt.settlement
    && typeof receipt.settlement === 'object'
    && typeof receipt.settlement.strategy === 'string'
    && Array.isArray(receipt.blockingSignals)
    && Object.hasOwn(receipt, 'recoveryHint');
}

function longSessionReportMissingFields(model = {}) {
  const missing = [];
  const actionsTotal = Number(model.counts?.actions ?? model.timelineWindow?.total);
  const actions = Array.isArray(model.actions) ? model.actions : [];
  const budget = model.reportBudget || {};
  const window = model.timelineWindow || {};
  const estimatedBytes = Number(budget.estimatedJsonBytes);
  const maxBytes = Number(budget.jsonBytesMax);
  const rawActionLimit = budget.actionLimit ?? window.limit;
  const actionLimit = rawActionLimit == null ? null : Number(rawActionLimit);

  if (!Number.isFinite(maxBytes)) missing.push('reportBudget.jsonBytesMax');
  if (!Number.isFinite(estimatedBytes) || (Number.isFinite(maxBytes) && estimatedBytes > maxBytes)) {
    missing.push('reportBudget.estimatedJsonBytes');
  }
  if (!Number.isFinite(actionLimit)) missing.push('reportBudget.actionLimit');
  if (window.expensive === true || budget.expensive === true) missing.push('timelineWindow.expensive');
  if (!Number.isFinite(window.omitted) || window.omitted <= 0) missing.push('timelineWindow.omitted');
  if (!Number.isFinite(window.shown) || window.shown !== actions.length) missing.push('timelineWindow.shown');
  if (Number.isFinite(actionLimit) && actions.length > actionLimit) missing.push('actions.window');
  if (Number.isFinite(actionsTotal) && actions.length >= actionsTotal) missing.push('actions.window');
  if (!model.latestAction || !Number.isFinite(model.latestAction.index) || !model.latestAction.action || !model.latestAction.status) {
    missing.push('latestAction');
  }
  if (!actions.some(reportActionHasRecoveryCriticalReceipt)) missing.push('actions.receipt');
  if (typeof model.paths?.log !== 'string' || !model.paths.log.trim()) missing.push('paths.log');
  if (typeof model.paths?.screenshotDir !== 'string' || !model.paths.screenshotDir.trim()) missing.push('paths.screenshotDir');
  return [...new Set(missing)];
}

function benchmarkLongSessionReportBudgetCoverage(steps) {
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    if (model?.schema !== 'chrome-cdp-ex.report.v1') continue;
    const actionsTotal = Number(model.counts?.actions ?? model.timelineWindow?.total);
    if (!Number.isFinite(actionsTotal) || actionsTotal < LONG_SESSION_REPORT_ACTIONS_MIN) continue;
    total += 1;
    const missingFields = longSessionReportMissingFields(model);
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

const LARGE_APP_STRESS_COMMANDS = Object.freeze(['perceive', 'controls', 'text', 'table', 'summary']);

function compactBenchmarkStep(step, reason = '') {
  if (!step) return null;
  return {
    name: step.name,
    commandText: step.commandText,
    durationMs: step.durationMs,
    outputChars: step.outputChars,
    estimatedTokens: step.estimatedTokens,
    ...(reason ? { reason } : {}),
  };
}

function firstLargeAppCulprit(entries, reason = '') {
  const entry = entries.find(item => item?.step);
  return entry ? compactBenchmarkStep(entry.step, reason || entry.reason || '') : null;
}

function largeAppCommandName(step = {}) {
  return String(step.command?.[0] || step.name || '').toLowerCase();
}

function numberFromText(text = '', patterns = []) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function modelNumber(model = {}, paths = []) {
  for (const path of paths) {
    const value = path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), model);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function largeAppOutputIsBudgeted(step = {}, model = null) {
  if (model?.budget && typeof model.budget === 'object') return true;
  if (model?.limits && typeof model.limits === 'object') {
    return ['outputTokenBudget', 'outputTokensMax', 'tokenBudget', 'nodeBudget', 'limit', 'rowBudget', 'tableRowBudget', 'controlsLimit']
      .some(field => Number.isFinite(model.limits[field]));
  }
  if (Number.isFinite(model?.limit)) return true;
  if (model && typeof model === 'object') return false;
  const text = step.outputText || outputText(step);
  return /\b(outputTokenBudget|tokenBudget|rowBudget|nodeBudget)\s*[=:]/i.test(text)
    || /\blimit\s+\d+/i.test(text)
    || /\(--auto limit \d+\)/i.test(text)
    || /--last\s+\d+/i.test(text)
    || /\bbudget\s+source/i.test(text)
    || /\bbudget:/i.test(text);
}

function largeAppHasTruncationMetadata(step = {}, model = null) {
  if (model?.limits && typeof model.limits === 'object' && model.limits.truncated === true) return true;
  if (model?.truncated === true) return true;
  if (Number.isFinite(model?.omitted) && model.omitted > 0) return true;
  if (Number.isFinite(model?.returned) && Number.isFinite(model?.total) && model.returned < model.total) return true;
  if (model && typeof model === 'object') return false;
  const text = step.outputText || outputText(step);
  return /\b(truncated|omitted|hidden template nodes omitted|hiddenTemplateNodesOmitted|earlier text node|more rows|rows? omitted)\b/i.test(text);
}

function collectLargeAppScale(steps = []) {
  const scale = {
    domNodes: 0,
    tableRows: 0,
    visibleControls: 0,
    hiddenTemplateNodes: 0,
  };
  for (const step of steps) {
    const model = stepModel(step) || parseJsonOutput(step.outputText);
    const text = step.outputText || outputText(step);
    scale.domNodes = Math.max(
      scale.domNodes,
      modelNumber(model, ['limits.sourceDomNodes', 'limits.domNodes', 'limits.nodeCount', 'counts.domNodes', 'metadata.domNodes']) || 0,
      numberFromText(text, [/sourceDomNodes=(\d+)/i, /domNodes=(\d+)/i, /(\d+)\s+DOM nodes?/i]) || 0,
    );
    scale.tableRows = Math.max(
      scale.tableRows,
      modelNumber(model, ['limits.sourceTableRows', 'limits.tableRows', 'counts.tableRows', 'metadata.tableRows']) || 0,
      numberFromText(text, [/sourceRows=(\d+)/i, /tableRows=(\d+)/i, /(\d+)\s+rows?\s+total/i]) || 0,
    );
    scale.visibleControls = Math.max(
      scale.visibleControls,
      modelNumber(model, ['interactive.total', 'counts.visibleControls', 'metadata.visibleControls', 'total']) || 0,
      numberFromText(text, [/visibleControls=(\d+)/i, /controls=(\d+)/i]) || 0,
    );
    scale.hiddenTemplateNodes = Math.max(
      scale.hiddenTemplateNodes,
      modelNumber(model, ['limits.hiddenTemplateNodesOmitted', 'limits.hiddenNodesOmitted', 'counts.hiddenTemplateNodes', 'metadata.hiddenTemplateNodes']) || 0,
      numberFromText(text, [/hiddenTemplateNodes=(\d+)/i, /hiddenTemplateNodesOmitted=(\d+)/i, /hidden template nodes? omitted=(\d+)/i]) || 0,
    );
  }
  return {
    ...scale,
    covered: scale.domNodes >= 5000 && scale.tableRows >= 1000 && scale.visibleControls >= 200,
  };
}

function largeAppVisibleControlsSummary(steps = []) {
  const controlsStep = steps.find(step => largeAppCommandName(step) === 'controls');
  const model = controlsStep ? (stepModel(controlsStep) || parseJsonOutput(controlsStep.outputText)) : null;
  const total = modelNumber(model, ['total', 'counts.visibleControls', 'metadata.visibleControls']);
  const returned = modelNumber(model, ['returned', 'counts.returnedControls']);
  const limit = modelNumber(model, ['limit', 'limits.controlsLimit', 'limits.limit']);
  const bounded = Boolean(controlsStep
    && Number.isFinite(total)
    && Number.isFinite(returned)
    && Number.isFinite(limit)
    && total >= 200
    && returned <= limit
    && limit <= 50
    && model?.truncated === true);
  return {
    total: total ?? null,
    returned: returned ?? null,
    limit: limit ?? null,
    bounded,
    culprit: bounded ? null : compactBenchmarkStep(controlsStep, 'visible controls are not bounded to a <=50 item limit'),
  };
}

function largeAppHiddenTemplateOmissionSummary(steps = [], scale = null) {
  const culprit = steps.find(step => largeAppCommandName(step) === 'perceive') || steps[0] || null;
  const covered = Boolean((scale?.hiddenTemplateNodes || 0) > 0
    && steps.some((step) => {
      const model = stepModel(step) || parseJsonOutput(step.outputText);
      const text = step.outputText || outputText(step);
      return Number.isFinite(model?.limits?.hiddenTemplateNodesOmitted)
        || Number.isFinite(model?.limits?.hiddenNodesOmitted)
        || /hiddenTemplateNodesOmitted=\d+/i.test(text)
        || /hidden template nodes? omitted=\d+/i.test(text);
    }));
  return {
    covered,
    hiddenTemplateNodes: scale?.hiddenTemplateNodes || 0,
    culprit: covered ? null : compactBenchmarkStep(culprit, 'hidden/template node omission metadata is missing'),
  };
}

function coverageForLargeAppCommands(steps = [], predicate, reason) {
  const missing = [];
  let covered = 0;
  for (const commandName of LARGE_APP_STRESS_COMMANDS) {
    const step = steps.find(candidate => largeAppCommandName(candidate) === commandName);
    if (step && predicate(step, stepModel(step) || parseJsonOutput(step.outputText))) {
      covered += 1;
    } else {
      missing.push({ command: commandName, step, reason });
    }
  }
  return {
    total: LARGE_APP_STRESS_COMMANDS.length,
    covered,
    rate: covered / LARGE_APP_STRESS_COMMANDS.length,
    missing,
    culprit: firstLargeAppCulprit(missing, reason),
  };
}

function benchmarkLargeAppStress(steps = []) {
  const commandCoverage = coverageForLargeAppCommands(
    steps,
    step => Boolean(step),
    'required large-app stress command was not observed',
  );
  const outputBudgetCoverage = coverageForLargeAppCommands(
    steps,
    largeAppOutputIsBudgeted,
    'output budget metadata is missing',
  );
  const truncationMetadataCoverage = coverageForLargeAppCommands(
    steps,
    largeAppHasTruncationMetadata,
    'truncation or omission metadata is missing',
  );
  const scale = collectLargeAppScale(steps);
  const visibleControls = largeAppVisibleControlsSummary(steps);
  const hiddenTemplateOmission = largeAppHiddenTemplateOmissionSummary(steps, scale);
  return {
    enabled: true,
    expectedCommands: [...LARGE_APP_STRESS_COMMANDS],
    commandCoverage,
    outputBudgetCoverage,
    truncationMetadataCoverage,
    scale,
    visibleControls,
    hiddenTemplateOmission,
    success: commandCoverage.rate === 1
      && outputBudgetCoverage.rate === 1
      && truncationMetadataCoverage.rate === 1
      && scale.covered
      && visibleControls.bounded
      && hiddenTemplateOmission.covered,
  };
}

function countsTowardUsefulObservationTokens(step) {
  const model = stepModel(step);
  const commandName = normalizeActionCommandName(step.command?.[0] || step.name);
  if (commandName === 'report' || model?.schema === 'chrome-cdp-ex.report.v1') return false;
  if (MUTATING_COMMANDS.has(commandName) || model?.schema === 'chrome-cdp-ex.action.v1') return false;
  return step.hasUsefulObservation;
}

function isIntentionalStabilityWaitStep(step = {}) {
  const commandName = normalizeActionCommandName(step.command?.[0] || step.name);
  return step.name === 'stability-wait' && commandName === 'wait';
}

function slowestStepByDuration(steps = []) {
  return steps.reduce((slowest, step) => (
    !slowest || step.durationMs > slowest.durationMs ? step : slowest
  ), null);
}

const DEFAULT_GATE_LIMITS = Object.freeze({
  commandCallsMax: 24,
  firstUsefulObservationMsMax: 5000,
  firstActionEvidenceMsMax: 5000,
  goldenPathMsMax: 120000,
  // Real-app adversarial campaigns exercise extra probes (table/shadow/slow-network)
  // on top of the golden path. Keep useful-observation budgets tight, but leave
  // modest headroom so total handoff noise does not falsely fail a healthy run.
  estimatedOutputTokensMax: 13500,
  maxStepEstimatedTokensMax: 5000,
  maxStepDurationMsMax: 5000,
  usefulObservationTokensMax: 3000,
  autoEvidenceActionsMin: 1,
  observedActionEvidenceCoverageRateMin: 1,
  actionEvidenceCompletenessCoverageRateMin: 1,
  actionFailureDiagnosisCoverageRateMin: 1,
  actionNoChangeRecoveryCoverageRateMin: 1,
  cliRecoveryCoverageRateMin: 1,
  handoffNextStepsCoverageRateMin: 1,
  handoffRecommendationCoverageRateMin: 1,
  doctorOnboardingCoverageRateMin: 1,
  targetHandoffCoverageRateMin: 1,
  reportLatestActionCoverageRateMin: 1,
  reportTimelineWindowCoverageRateMin: 1,
  reportArtifactCoverageRateMin: 1,
  longSessionReportBudgetCoverageRateMin: 1,
  perceptionSignalCoverageRateMin: 1,
  sinceActionEvidenceCoverageRateMin: 1,
  differentiatorSuccessRateMin: 1,
  differentiatorHandoffCoverageRateMin: 1,
  staleRefRecoveryRateMin: 1,
  largeAppCommandCoverageRateMin: 1,
  largeAppOutputBudgetCoverageRateMin: 1,
  largeAppTruncationMetadataCoverageRateMin: 1,
  largeAppDomNodesMin: 5000,
  largeAppTableRowsMin: 1000,
  largeAppVisibleControlsMin: 200,
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

function gateCriterion({ name, actual, operator, limit, recommendation, culprit = null }) {
  let passed = false;
  if (operator === '<=') passed = actual !== null && actual !== undefined && actual <= limit;
  if (operator === '>=') passed = actual !== null && actual !== undefined && actual >= limit;
  if (operator === '===') passed = actual === limit;
  return { name, passed, actual, operator, limit, recommendation, ...(culprit ? { culprit } : {}) };
}

function buildLargeAppStressGate(summary, limits = DEFAULT_GATE_LIMITS) {
  const metrics = summary.metrics || {};
  const largeAppStress = metrics.largeAppStress || {};
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
      recommendation: 'Keep the large-app stress probe compact; run only the perception and extraction commands that prove bounded output.',
    }),
    gateCriterion({
      name: 'first-useful-observation',
      actual: metrics.firstUsefulObservationMs ?? null,
      operator: '<=',
      limit: limits.firstUsefulObservationMsMax,
      recommendation: 'Large app perception must produce a useful observation quickly enough for first-run agent loops.',
    }),
    gateCriterion({
      name: 'total-output-tokens',
      actual: metrics.estimatedOutputTokens ?? null,
      operator: '<=',
      limit: limits.estimatedOutputTokensMax,
      recommendation: 'Keep total stress output bounded so large DOMs cannot silently consume the model context.',
      culprit: metrics.biggestOutputStep || null,
    }),
    gateCriterion({
      name: 'max-step-output-tokens',
      actual: metrics.maxStepEstimatedTokens ?? null,
      operator: '<=',
      limit: limits.maxStepEstimatedTokensMax,
      recommendation: 'Keep any single stress command from dumping the app; inspect the culprit command output.',
      culprit: metrics.biggestOutputStep || null,
    }),
    gateCriterion({
      name: 'max-step-duration',
      actual: metrics.maxResponsiveStepDurationMs ?? metrics.maxStepDurationMs ?? null,
      operator: '<=',
      limit: limits.maxStepDurationMsMax,
      recommendation: 'Keep each large-app command responsive enough for interactive repair loops.',
      culprit: metrics.slowestResponsiveStep || metrics.slowestStep || null,
    }),
    gateCriterion({
      name: 'useful-observation-tokens',
      actual: metrics.usefulObservationTokens ?? null,
      operator: '<=',
      limit: limits.usefulObservationTokensMax,
      recommendation: 'Large app perception should summarize actionable state instead of dumping every visible node.',
    }),
    gateCriterion({
      name: 'large-app-command-coverage',
      actual: largeAppStress.commandCoverage?.rate ?? null,
      operator: '>=',
      limit: limits.largeAppCommandCoverageRateMin,
      recommendation: 'Exercise perceive -C, controls, text --auto, table, and summary in the stress scenario.',
      culprit: largeAppStress.commandCoverage?.culprit || null,
    }),
    gateCriterion({
      name: 'large-app-scale-coverage',
      actual: largeAppStress.scale?.covered === true,
      operator: '===',
      limit: true,
      recommendation: 'The stress fixture must cover at least 5000 DOM nodes, 1000 table rows, and 200 visible controls.',
      culprit: largeAppStress.commandCoverage?.culprit || null,
    }),
    gateCriterion({
      name: 'large-app-output-budget-metadata',
      actual: largeAppStress.outputBudgetCoverage?.rate ?? null,
      operator: '>=',
      limit: limits.largeAppOutputBudgetCoverageRateMin,
      recommendation: 'Every stress command must expose or print output budget/limit metadata.',
      culprit: largeAppStress.outputBudgetCoverage?.culprit || null,
    }),
    gateCriterion({
      name: 'large-app-truncation-metadata',
      actual: largeAppStress.truncationMetadataCoverage?.rate ?? null,
      operator: '>=',
      limit: limits.largeAppTruncationMetadataCoverageRateMin,
      recommendation: 'Every stress command must expose truncation or omission metadata so hidden/template nodes cannot dominate.',
      culprit: largeAppStress.truncationMetadataCoverage?.culprit || null,
    }),
    gateCriterion({
      name: 'large-app-visible-controls-bounded',
      actual: largeAppStress.visibleControls?.bounded === true,
      operator: '===',
      limit: true,
      recommendation: 'Visible controls inventory must be discoverable but capped to a <=30 item response.',
      culprit: largeAppStress.visibleControls?.culprit || null,
    }),
    gateCriterion({
      name: 'large-app-hidden-template-omission',
      actual: largeAppStress.hiddenTemplateOmission?.covered === true,
      operator: '===',
      limit: true,
      recommendation: 'Stress output must explicitly omit hidden/template DOM so invisible app scaffolding cannot dominate perception.',
      culprit: largeAppStress.hiddenTemplateOmission?.culprit || null,
    }),
  ];
  const passedCount = criteria.filter(criterion => criterion.passed).length;
  return {
    schema: 'chrome-cdp-ex.benchmark-gate.v1',
    profile: 'large-app-stress',
    passed: passedCount === criteria.length,
    passedCount,
    total: criteria.length,
    criteria,
  };
}

export function buildBenchmarkGate(summary, limits = DEFAULT_GATE_LIMITS) {
  const metrics = summary.metrics || {};
  if (metrics.largeAppStress?.enabled === true) {
    return buildLargeAppStressGate(summary, limits);
  }
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
      name: 'first-action-evidence',
      actual: metrics.firstActionEvidenceMs ?? null,
      operator: '<=',
      limit: limits.firstActionEvidenceMsMax,
      recommendation: 'Return the first action evidence quickly enough that agents do not need manual verification loops.',
      culprit: metrics.firstActionEvidenceStep || null,
    }),
    gateCriterion({
      name: 'golden-path-under-two-minutes',
      actual: metrics.goldenPathMs ?? null,
      operator: '<=',
      limit: limits.goldenPathMsMax,
      recommendation: 'Complete doctor/list/perceive/action/report within the two-minute first-success budget.',
    }),
    gateCriterion({
      name: 'total-output-tokens',
      actual: metrics.estimatedOutputTokens ?? null,
      operator: '<=',
      limit: limits.estimatedOutputTokensMax,
      recommendation: 'Keep total benchmark output bounded so live-agent sessions do not silently consume the model context.',
      culprit: metrics.biggestOutputStep || null,
    }),
    gateCriterion({
      name: 'max-step-output-tokens',
      actual: metrics.maxStepEstimatedTokens ?? null,
      operator: '<=',
      limit: limits.maxStepEstimatedTokensMax,
      recommendation: 'Keep any single benchmark command from dominating handoff tokens; inspect the culprit step output.',
      culprit: metrics.biggestOutputStep || null,
    }),
    gateCriterion({
      name: 'max-step-duration',
      actual: metrics.maxResponsiveStepDurationMs ?? metrics.maxStepDurationMs ?? null,
      operator: '<=',
      limit: limits.maxStepDurationMsMax,
      recommendation: 'Keep individual benchmark commands responsive; intentional stability waits are tracked separately.',
      culprit: metrics.slowestResponsiveStep || metrics.slowestStep || null,
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
      recommendation: 'Action JSON evidence must include the Action Receipt contract: event id, dispatch, settlement semantics, observed delta details, blocking signals, recovery hint, and next steps.',
    }),
    gateCriterion({
      name: 'action-failure-diagnosis',
      actual: metrics.actionFailureDiagnosisCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.actionFailureDiagnosisCoverageRateMin,
      recommendation: 'Failed action JSON must classify the failure and expose diagnosis recovery commands so agents can recover without parsing text.',
    }),
    gateCriterion({
      name: 'action-no-change-recovery',
      actual: metrics.actionNoChangeRecoveryCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.actionNoChangeRecoveryCoverageRateMin,
      recommendation: 'No-change action JSON must route agents to target-aware overlay/frame checks, fresh perceive, and report instead of treating dispatch as success.',
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
      name: 'long-session-report-budget',
      actual: metrics.longSessionReportBudgetCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.longSessionReportBudgetCoverageRateMin,
      recommendation: 'Long-session report JSON must stay within its byte budget, expose latestAction, bound the timeline window, keep recovery-critical receipts, and point to artifacts instead of dumping all history.',
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
      recommendation: 'Keep modal/overlay, frame refs, CSS trace, HMR/SPAs, and guarded pages green before making differentiation claims.',
    }),
    gateCriterion({
      name: 'differentiator-handoff-coverage',
      actual: metrics.differentiatorHandoffCoverage?.rate ?? 1,
      operator: '>=',
      limit: limits.differentiatorHandoffCoverageRateMin,
      recommendation: 'Keep overlay, frame, and cascade JSON probes agent-readable before making differentiation claims.',
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
  if (metrics.adversarialScenario?.enabled === true) {
    const adversarial = metrics.adversarialScenario;
    criteria.push(
      gateCriterion({
        name: 'adversarial-scenario-generated',
        actual: adversarial.generatedCoverage?.rate ?? null,
        operator: '>=',
        limit: 1,
        recommendation: 'Generated adversarial scenarios must compose overlay, stale-ref, iframe, shadow DOM, SPA route, slow network, auth wall, large table, and hidden-template traits.',
      }),
      gateCriterion({
        name: 'adversarial-scenario-exercised',
        actual: adversarial.exercisedCoverage?.rate ?? null,
        operator: '>=',
        limit: 1,
        recommendation: 'Adversarial runs must exercise at least the live-only slow-network, large-table, and shadow-DOM probes when those traits are generated.',
      }),
      gateCriterion({
        name: 'adversarial-scenario-replay',
        actual: Boolean(adversarial.seed && adversarial.replayCommand),
        operator: '===',
        limit: true,
        recommendation: 'Adversarial failures must record a seed and replay command for issue-ready diagnostics.',
      }),
    );
  }
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

function hashAdversarialSeed(seed = '') {
  let hash = 2166136261;
  for (const char of String(seed || 'default')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeAdversarialSeed(seed = '') {
  const normalized = String(seed || '').trim();
  return normalized || 'default';
}

function normalizeAdversarialTraits(traits = null) {
  const requested = Array.isArray(traits)
    ? traits
    : String(traits || '')
      .split(',')
      .map(trait => trait.trim())
      .filter(Boolean);
  const selected = requested.length ? requested : ADVERSARIAL_TRAITS;
  const invalid = selected.filter(trait => !ADVERSARIAL_TRAITS.includes(trait));
  if (invalid.length) throw new Error(`unknown adversarial trait(s): ${invalid.join(', ')}`);
  return [...new Set(selected)];
}

function htmlEscape(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildAdversarialScenario(seed = 'default', opts = {}) {
  const normalizedSeed = normalizeAdversarialSeed(seed);
  const traits = normalizeAdversarialTraits(opts.traits);
  const hash = hashAdversarialSeed(normalizedSeed);
  const tableRows = opts.tableRows ?? (traits.includes('large-table') ? 180 + (hash % 90) : 12);
  const hiddenTemplateNodes = opts.hiddenTemplateNodes ?? (traits.includes('hidden-template') ? 120 + (hash % 80) : 0);
  const slowNetworkMs = opts.slowNetworkMs ?? (traits.includes('slow-network') ? 450 + (hash % 350) : 0);
  const routeName = `route-${(hash % 997).toString(36)}`;
  const targetClass = [
    traits.includes('auth-wall') ? 'auth' : null,
    traits.includes('iframe') ? 'iframe' : null,
    traits.includes('shadow-dom') ? 'shadow' : null,
    traits.includes('large-table') ? 'table' : null,
    traits.includes('slow-network') ? 'slow-network' : null,
  ].filter(Boolean).join('+') || 'base';
  const scenario = {
    schema: 'chrome-cdp-ex.adversarial-scenario.v1',
    seed: normalizedSeed,
    hash,
    targetClass,
    traits,
    tableRows,
    hiddenTemplateNodes,
    slowNetworkMs,
    routeName,
    path: `/adversarial-${encodeURIComponent(normalizedSeed)}.html`,
    replayCommand: `npm run benchmark:killer -- --json --adversarial-seed ${JSON.stringify(normalizedSeed)}`,
  };
  return {
    ...scenario,
    html: buildAdversarialScenarioHtml(scenario),
  };
}

export function buildAdversarialScenarioHtml(scenario = { seed: 'default', traits: ADVERSARIAL_TRAITS }) {
  const traits = new Set(normalizeAdversarialTraits(scenario.traits));
  const seed = htmlEscape(normalizeAdversarialSeed(scenario.seed));
  const tableRows = Math.max(1, Number(scenario.tableRows || 12));
  const hiddenTemplateNodes = Math.max(0, Number(scenario.hiddenTemplateNodes || 0));
  const slowNetworkMs = Math.max(0, Number(scenario.slowNetworkMs || 0));
  const routeName = htmlEscape(scenario.routeName || 'route');
  const renderedTableRows = Math.min(tableRows, 24);
  const tableBody = Array.from({ length: renderedTableRows }, (_, index) => {
    const n = index + 1;
    return `<tr><td>acct-${n}</td><td>${n % 5 === 0 ? 'review' : 'active'}</td><td>team-${(n % 7) + 1}</td></tr>`;
  }).join('\n');
  const hiddenNodes = Array.from({ length: hiddenTemplateNodes }, (_, index) => (
    `<div data-hidden-template-node="${index + 1}">hidden adversarial template ${index + 1}</div>`
  )).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>chrome-cdp-ex adversarial ${seed}</title>
  <style>
    body { margin: 0; min-height: 2200px; font-family: system-ui, sans-serif; background: #f8fafc; color: #172033; }
    main { max-width: 940px; padding: 28px; }
    button, input { font: inherit; margin: 4px; padding: 8px 12px; }
    #combat-log { height: 260px; overflow: auto; border: 1px solid #cbd5e1; background: white; padding: 10px; }
    #auth-panel { border: 1px solid #86efac; background: #f0fdf4; margin: 14px 0; padding: 12px; }
    #custom-clickable { display: inline-block; cursor: pointer; padding: 8px 12px; background: #fde68a; border-radius: 6px; }
    #scenario-table { width: 100%; border-collapse: collapse; margin-top: 18px; }
    #scenario-table td, #scenario-table th { border: 1px solid #cbd5e1; padding: 4px 6px; }
    [role="dialog"] { position: fixed; z-index: 30; top: 18%; left: 50%; transform: translateX(-50%); background: white; border: 2px solid #172033; box-shadow: 0 20px 60px #0005; padding: 18px; }
    .route-panel { border: 1px solid #93c5fd; background: #eff6ff; padding: 10px; margin: 12px 0; }
    [hidden] { display: none !important; }
  </style>
</head>
<body data-adversarial-seed="${seed}" data-adversarial-traits="${htmlEscape((scenario.traits || []).join(','))}">
  <main>
    <h1>Adversarial browser scenario ${seed}</h1>
    <p id="scenario-meta">traits: ${htmlEscape((scenario.traits || []).join(', '))}; tableRows=${tableRows}; hiddenTemplateNodes=${hiddenTemplateNodes}; slowNetworkMs=${slowNetworkMs}</p>
    <input id="cmd" aria-label="command input" placeholder="look trainer">
    <button id="combat" type="button">Run combat</button>
    <button id="diagnostic" type="button">Run diagnostic</button>
    <button id="noop" type="button">No visible change</button>
    <div id="custom-clickable" onclick="appendLog('custom clickable used')">Custom clickable div</div>
    ${traits.has('auth-wall') ? '<section id="auth-panel" role="region" aria-label="Authenticated guarded dashboard"><h2>Authenticated dashboard</h2><p id="auth-state">guarded dashboard authenticated</p><button id="refresh-account" type="button">Refresh account</button></section>' : '<section id="auth-panel" role="region" aria-label="Dashboard"><h2>Dashboard</h2><p id="auth-state">dashboard ready</p><button id="refresh-account" type="button">Refresh account</button></section>'}
    ${traits.has('spa-route') ? `<section class="route-panel" aria-label="SPA route"><h2>SPA route</h2><p id="route-state">route pending ${routeName}</p><button id="route-button" type="button">Navigate route</button></section>` : ''}
    <section role="region" aria-label="Event log">
      <h2>Event log</h2>
      <div id="combat-log"></div>
    </section>
    ${traits.has('shadow-dom') ? '<shadow-action-card id="shadow-card"></shadow-action-card>' : ''}
    ${traits.has('iframe') ? '<iframe title="Adversarial child frame" name="adversarial-child" srcdoc="<main><h2>Adversarial child frame</h2><button id=&quot;child-action&quot;>Child action</button><p id=&quot;child-status&quot;>child:none</p><script>document.getElementById(&quot;child-action&quot;).addEventListener(&quot;click&quot;,()=>{document.getElementById(&quot;child-status&quot;).textContent=&quot;success: child clicked&quot;;});</script></main>"></iframe>' : ''}
    ${traits.has('large-table') ? `<table id="scenario-table" data-source-rows="${tableRows}"><caption>Adversarial large table ${tableRows} rows, renderedRows=${renderedTableRows}</caption><thead><tr><th>account</th><th>status</th><th>owner</th></tr></thead><tbody>${tableBody}<tr><td colspan="3">... ${Math.max(0, tableRows - renderedTableRows)} rows omitted in fixture DOM</td></tr></tbody></table>` : ''}
    ${traits.has('hidden-template') ? `<template id="adversarial-template">${hiddenNodes}</template><section id="hidden-templates" hidden>${hiddenNodes}</section>` : ''}
  </main>
  ${traits.has('overlay') ? '<div role="dialog" aria-modal="true" aria-label="Adversarial MOTD" id="motd"><p>Adversarial modal blocks first action</p><button aria-label="Close" id="close-modal" type="button">Close</button></div>' : ''}
  <script>
    const log = document.getElementById('combat-log');
    function appendLog(text) {
      const p = document.createElement('p');
      p.textContent = text;
      log.appendChild(p);
      log.scrollTop = log.scrollHeight;
    }
    window.appendLog = appendLog;
    for (let i = 1; i <= 80; i++) appendLog('history #' + i);
    ${traits.has('shadow-dom') ? "customElements.define('shadow-action-card', class extends HTMLElement { connectedCallback() { const root = this.attachShadow({ mode: 'open' }); root.innerHTML = '<section aria-label=\"Shadow DOM task\"><button id=\"shadow-action\" type=\"button\">Shadow action</button><p id=\"shadow-status\">shadow:none</p></section>'; root.getElementById('shadow-action').addEventListener('click', () => { root.getElementById('shadow-status').textContent = 'shadow:clicked'; appendLog('shadow action clicked'); }); } });" : ''}
    document.getElementById('combat').addEventListener('click', () => {
      appendLog('combat started');
      setTimeout(() => appendLog('round 1'), 80);
      setTimeout(() => appendLog('combat victory'), 180);
    });
    document.getElementById('diagnostic').addEventListener('click', async () => {
      appendLog('diagnostic started');
      try {
        const response = await fetch('/api/slow?seed=${encodeURIComponent(scenario.seed || 'default')}&delay=${slowNetworkMs}', { method: 'POST' });
        appendLog('diagnostic network ' + response.status);
      } catch {
        appendLog('diagnostic network failed');
      }
    });
    document.getElementById('noop').addEventListener('click', () => document.getElementById('noop').blur());
    document.getElementById('refresh-account').addEventListener('click', () => {
      document.getElementById('auth-state').textContent = 'guarded dashboard refreshed';
      appendLog('authenticated dashboard refreshed');
    });
    const modalClose = document.getElementById('close-modal');
    if (modalClose) modalClose.addEventListener('click', () => {
      document.getElementById('motd').hidden = true;
      appendLog('modal dismissed');
    });
    const routeButton = document.getElementById('route-button');
    if (routeButton) routeButton.addEventListener('click', () => {
      location.hash = '${routeName}';
      document.getElementById('route-state').textContent = 'route active ${routeName}';
      appendLog('spa route ${routeName}');
    });
    window.addEventListener('hashchange', () => appendLog('hash route ' + location.hash.slice(1)));
  </script>
</body>
</html>`;
}

export function buildLargeAppStressFixture({
  target = 'AABBCCDD',
  startedAt = 0,
  domNodes = 5200,
  tableRows = 1000,
  visibleControls = 240,
  hiddenTemplateNodes = 1600,
  controlsLimit = 30,
  nodeBudget = 80,
  tableRowBudget = 20,
  outputTokenBudget = 1200,
} = {}) {
  const step = (name, command, startOffset, durationMs, stdout) => ({
    name,
    command,
    startedAt: startedAt + startOffset,
    endedAt: startedAt + startOffset + durationMs,
    status: 0,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr: '',
  });
  const controlRows = Array.from({ length: controlsLimit }, (_, index) => ({
    ref: `@${index + 1}`,
    role: index % 3 === 0 ? 'button' : index % 3 === 1 ? 'textbox' : 'link',
    label: `Visible control ${index + 1}`,
    selector: `[data-control="${index + 1}"]`,
  }));
  const rows = [
    'account\tstatus\towner',
    ...Array.from({ length: Math.min(tableRowBudget, 5) }, (_, index) => `account-${index + 1}\tactive\tteam-${index + 1}`),
  ].join('\n');
  const steps = [
    step('perceive', ['perceive', target, ...LARGE_APP_PERCEIVE_ARGS], 0, 110, {
      schema: 'chrome-cdp-ex.perceive.v1',
      targetPrefix: target,
      page: { title: 'Large SaaS stress fixture', url: 'https://example.test/large-app' },
      viewport: { width: 1440, height: 900, coordinateSpace: 'viewport-css-px' },
      console: { errors: 0, warnings: 2, recent: ['2 noisy logs summarized'] },
      refs: { count: controlsLimit, validity: 'until-navigation-or-dom-rewrite' },
      nodes: [
        { ref: '@1', role: 'button', name: 'Create invoice' },
        { ref: '@2', role: 'textbox', name: 'Search accounts' },
      ],
      interactive: { total: visibleControls, returned: controlsLimit, truncated: true },
      limits: {
        sourceDomNodes: domNodes,
        returnedNodes: nodeBudget,
        nodeBudget,
        outputTokenBudget,
        hiddenTemplateNodesOmitted: hiddenTemplateNodes,
        truncated: true,
      },
      recommendation: {
        summary: 'Use bounded controls before acting in the dense dashboard.',
        run: `cdp controls ${target} --limit ${controlsLimit} --format json`,
        commands: [`cdp controls ${target} --limit ${controlsLimit} --format json`],
      },
      nextSteps: [`cdp controls ${target} --limit ${controlsLimit} --format json`],
    }),
    step('controls', ['controls', target, '--limit', String(controlsLimit), '--format', 'json'], 120, 90, {
      schema: 'chrome-cdp-ex.visible-controls.v1',
      scope: 'document',
      filter: null,
      limit: controlsLimit,
      total: visibleControls,
      returned: controlsLimit,
      truncated: true,
      omitted: visibleControls - controlsLimit,
      budget: { outputTokenBudget, controlLimit: controlsLimit },
      limits: {
        controlsLimit,
        outputTokenBudget,
        hiddenTemplateNodesOmitted: hiddenTemplateNodes,
        truncated: true,
      },
      controls: controlRows,
    }),
    step(
      'text',
      ['text', target, '--auto'],
      220,
      70,
      [
        `Visible text budget: sourceDomNodes=${domNodes} hiddenTemplateNodes=${hiddenTemplateNodes} outputTokenBudget=${outputTokenBudget}`,
        'Dashboard text: Accounts, invoices, approvals, alerts, activity feed',
        `... ${Math.max(0, domNodes - 120)} earlier text node(s) omitted (--auto limit ${outputTokenBudget})`,
        `... hidden template nodes omitted=${hiddenTemplateNodes} truncated=true`,
      ].join('\n'),
    ),
    step(
      'table',
      ['table', target, '#accounts-grid'],
      300,
      85,
      [
        rows,
        `... ${tableRows - tableRowBudget} rows omitted (limit ${tableRowBudget} of ${tableRows} rows total)`,
        `budget sourceRows=${tableRows} returnedRows=${tableRowBudget} outputTokenBudget=${outputTokenBudget} truncated=true`,
      ].join('\n'),
    ),
    step('summary', ['summary', target, '--format', 'json'], 395, 60, {
      schema: 'chrome-cdp-ex.summary.v1',
      page: { title: 'Large SaaS stress fixture' },
      counts: {
        domNodes,
        tableRows,
        visibleControls,
        hiddenTemplateNodes,
      },
      limits: {
        nodeBudget,
        tableRowBudget,
        controlsLimit,
        outputTokenBudget,
        hiddenTemplateNodesOmitted: hiddenTemplateNodes,
        truncated: true,
      },
      recommendation: {
        summary: 'Continue with bounded controls or scoped table extraction.',
        run: `cdp controls ${target} --limit ${controlsLimit} --format json`,
        commands: [`cdp controls ${target} --limit ${controlsLimit} --format json`],
      },
      nextSteps: [`cdp controls ${target} --limit ${controlsLimit} --format json`],
    }),
  ];
  return {
    scenario: 'large-app-stress',
    startedAt,
    endedAt: steps.at(-1).endedAt,
    target,
    metadata: {
      domNodes,
      tableRows,
      visibleControls,
      hiddenTemplateNodes,
      controlsLimit,
      nodeBudget,
      tableRowBudget,
      outputTokenBudget,
    },
    steps,
  };
}

export function buildLargeAppStressHtml({
  domNodes = 5200,
  tableRows = 1000,
  visibleControls = 240,
  hiddenTemplateNodes = 1600,
  tableRowBudget = 20,
  outputTokenBudget = 1200,
} = {}) {
  const controls = Array.from({ length: visibleControls }, (_, index) => {
    const n = index + 1;
    if (index % 3 === 0) return `<button data-control="${n}" type="button">Visible control ${n}</button>`;
    if (index % 3 === 1) return `<input data-control="${n}" aria-label="Visible control ${n}" value="account-${n}">`;
    return `<a data-control="${n}" href="#account-${n}">Visible control ${n}</a>`;
  }).join('\n');
  const visibleRows = Array.from({ length: tableRowBudget }, (_, index) => {
    const n = index + 1;
    return `<tr><td>account-${n}</td><td>active</td><td>team-${n}</td></tr>`;
  }).join('\n');
  const hiddenNodes = Array.from({ length: hiddenTemplateNodes }, (_, index) => (
    `<div data-hidden-template-node="${index + 1}">hidden template node ${index + 1}</div>`
  )).join('\n');
  const fillerCount = Math.max(0, domNodes - visibleControls - hiddenTemplateNodes - tableRowBudget - 100);
  const fillerNodes = Array.from({ length: fillerCount }, (_, index) => (
    `<span data-filler-node="${index + 1}"></span>`
  )).join('\n');
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Large SaaS stress fixture domNodes=${domNodes} tableRows=${tableRows} visibleControls=${visibleControls} hiddenTemplateNodes=${hiddenTemplateNodes}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; }
      main { padding: 24px; }
      #control-grid { display: grid; grid-template-columns: repeat(12, minmax(90px, 1fr)); gap: 6px; }
      #accounts-grid { margin-top: 24px; width: 100%; border-collapse: collapse; }
      #accounts-grid th, #accounts-grid td { border: 1px solid #ccc; padding: 4px 6px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Large SaaS stress fixture</h1>
      <p id="stress-metadata">sourceDomNodes=${domNodes} tableRows=${tableRows} visibleControls=${visibleControls} hiddenTemplateNodes=${hiddenTemplateNodes} outputTokenBudget=${outputTokenBudget} hidden template nodes omitted=${hiddenTemplateNodes} truncated=true</p>
      <section id="control-grid" aria-label="Visible controls">
        ${controls}
      </section>
      <table id="accounts-grid" data-source-rows="${tableRows}">
        <caption>budget sourceRows=${tableRows} returnedRows=${tableRowBudget} outputTokenBudget=${outputTokenBudget} truncated=true</caption>
        <thead><tr><th>account</th><th>status</th><th>owner</th></tr></thead>
        <tbody>
          ${visibleRows}
          <tr><td colspan="3">... ${tableRows - tableRowBudget} rows omitted (limit ${tableRowBudget} of ${tableRows} rows total)</td></tr>
        </tbody>
      </table>
      <section id="hidden-templates" data-hidden-template hidden>
        ${hiddenNodes}
        ${fillerNodes}
      </section>
    </main>
  </body>
</html>`;
}

export function summarizeBenchmarkRun({ scenario = 'killer-path', startedAt, endedAt, target = '', steps = [], comparisonBaselineSet = DEFAULT_COMPARISON_BASELINE_SET, adversarialScenario = null } = {}) {
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
  const biggestOutputStep = normalizedSteps.reduce((biggest, step) => (
    !biggest || step.estimatedTokens > biggest.estimatedTokens ? step : biggest
  ), null);
  const slowestStep = slowestStepByDuration(normalizedSteps);
  const slowestResponsiveStep = slowestStepByDuration(
    normalizedSteps.filter(step => !isIntentionalStabilityWaitStep(step)),
  );
  const stepBudgetSummary = (step) => step
    ? {
        name: step.name,
        commandText: step.commandText,
        durationMs: step.durationMs,
        outputChars: step.outputChars,
        estimatedTokens: step.estimatedTokens,
      }
    : null;

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
      maxStepEstimatedTokens: biggestOutputStep?.estimatedTokens ?? 0,
      maxStepDurationMs: slowestStep?.durationMs ?? 0,
      maxResponsiveStepDurationMs: slowestResponsiveStep?.durationMs ?? 0,
      biggestOutputStep: stepBudgetSummary(biggestOutputStep),
      slowestStep: stepBudgetSummary(slowestStep),
      slowestResponsiveStep: stepBudgetSummary(slowestResponsiveStep),
      firstActionEvidenceStep: stepBudgetSummary(firstActionEvidence),
      usefulObservationTokens,
      autoEvidenceActions: actionEvidenceSteps.length,
      actionEvidenceCoverage: benchmarkActionEvidenceCoverage(normalizedSteps),
      actionEvidenceCompletenessCoverage: benchmarkActionEvidenceCompletenessCoverage(normalizedSteps),
      actionFailureDiagnosisCoverage: benchmarkActionFailureDiagnosisCoverage(normalizedSteps),
      actionNoChangeRecoveryCoverage: benchmarkActionNoChangeRecoveryCoverage(normalizedSteps),
      cliRecoveryCoverage: benchmarkCliRecoveryCoverage(normalizedSteps),
      handoffNextStepsCoverage: benchmarkHandoffNextStepsCoverage(normalizedSteps),
      handoffRecommendationCoverage: benchmarkHandoffRecommendationCoverage(normalizedSteps),
      doctorOnboardingCoverage: benchmarkDoctorOnboardingCoverage(normalizedSteps),
      targetHandoffCoverage: benchmarkTargetHandoffCoverage(normalizedSteps),
      reportLatestActionCoverage: benchmarkReportLatestActionCoverage(normalizedSteps),
      reportTimelineWindowCoverage: benchmarkReportTimelineWindowCoverage(normalizedSteps),
      reportArtifactCoverage: benchmarkReportArtifactCoverage(normalizedSteps),
      longSessionReportBudgetCoverage: benchmarkLongSessionReportBudgetCoverage(normalizedSteps),
      perceptionSignalCoverage: benchmarkPerceptionSignalCoverage(normalizedSteps),
      sinceActionEvidenceCoverage: benchmarkSinceActionEvidenceCoverage(normalizedSteps),
      verificationCallsSaved: actionEvidenceSteps.length,
      hasReportTimeline: hasReportTimeline(reportStep || {}),
      differentiators: benchmarkDifferentiators(normalizedSteps),
      differentiatorHandoffCoverage: benchmarkDifferentiatorHandoffCoverage(normalizedSteps),
      staleRefRecovery: benchmarkStaleRefRecovery(normalizedSteps),
      sessionStability: benchmarkSessionStability(normalizedSteps),
      adversarialScenario: benchmarkAdversarialScenario(adversarialScenario, normalizedSteps),
      largeAppStress: scenario === 'large-app-stress'
        ? benchmarkLargeAppStress(normalizedSteps)
        : { enabled: false },
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
    `Action no-change recovery coverage: ${summary.metrics.actionNoChangeRecoveryCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.actionNoChangeRecoveryCoverage.rate * 100)}%`} (${summary.metrics.actionNoChangeRecoveryCoverage?.covered ?? 0}/${summary.metrics.actionNoChangeRecoveryCoverage?.total ?? 0})`,
    `CLI recovery coverage: ${summary.metrics.cliRecoveryCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.cliRecoveryCoverage.rate * 100)}%`} (${summary.metrics.cliRecoveryCoverage?.covered ?? 0}/${summary.metrics.cliRecoveryCoverage?.total ?? 0})`,
    `Handoff nextSteps coverage: ${summary.metrics.handoffNextStepsCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.handoffNextStepsCoverage.rate * 100)}%`} (${summary.metrics.handoffNextStepsCoverage?.covered ?? 0}/${summary.metrics.handoffNextStepsCoverage?.total ?? 0})`,
    `Handoff recommendation coverage: ${summary.metrics.handoffRecommendationCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.handoffRecommendationCoverage.rate * 100)}%`} (${summary.metrics.handoffRecommendationCoverage?.covered ?? 0}/${summary.metrics.handoffRecommendationCoverage?.total ?? 0})`,
    `Doctor onboarding coverage: ${summary.metrics.doctorOnboardingCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.doctorOnboardingCoverage.rate * 100)}%`} (${summary.metrics.doctorOnboardingCoverage?.covered ?? 0}/${summary.metrics.doctorOnboardingCoverage?.total ?? 0})`,
    `Target handoff coverage: ${summary.metrics.targetHandoffCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.targetHandoffCoverage.rate * 100)}%`} (${summary.metrics.targetHandoffCoverage?.covered ?? 0}/${summary.metrics.targetHandoffCoverage?.total ?? 0})`,
    `Report latestAction coverage: ${summary.metrics.reportLatestActionCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.reportLatestActionCoverage.rate * 100)}%`} (${summary.metrics.reportLatestActionCoverage?.covered ?? 0}/${summary.metrics.reportLatestActionCoverage?.total ?? 0})`,
    `Report timelineWindow coverage: ${summary.metrics.reportTimelineWindowCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.reportTimelineWindowCoverage.rate * 100)}%`} (${summary.metrics.reportTimelineWindowCoverage?.covered ?? 0}/${summary.metrics.reportTimelineWindowCoverage?.total ?? 0})`,
    `Report artifact coverage: ${summary.metrics.reportArtifactCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.reportArtifactCoverage.rate * 100)}%`} (${summary.metrics.reportArtifactCoverage?.covered ?? 0}/${summary.metrics.reportArtifactCoverage?.total ?? 0})`,
    `Long-session report budget coverage: ${summary.metrics.longSessionReportBudgetCoverage?.rate == null ? 'n/a' : `${Math.round(summary.metrics.longSessionReportBudgetCoverage.rate * 100)}%`} (${summary.metrics.longSessionReportBudgetCoverage?.covered ?? 0}/${summary.metrics.longSessionReportBudgetCoverage?.total ?? 0})`,
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
    `Guarded page: ${differentiators.guardedPage?.success ? 'yes' : 'no'} (${differentiators.guardedPage?.durationMs ?? 0} ms)`,
    `Stale-ref recovery: ${summary.metrics.staleRefRecovery?.success ? 'yes' : 'no'} (${summary.metrics.staleRefRecovery?.recovered ?? 0}/${summary.metrics.staleRefRecovery?.commandCalls ?? 0})`,
    summary.metrics.largeAppStress?.enabled
      ? `Large app stress: ${summary.metrics.largeAppStress.success ? 'pass' : 'fail'} (commands ${summary.metrics.largeAppStress.commandCoverage.covered}/${summary.metrics.largeAppStress.commandCoverage.total}, budgets ${summary.metrics.largeAppStress.outputBudgetCoverage.covered}/${summary.metrics.largeAppStress.outputBudgetCoverage.total}, truncation metadata ${summary.metrics.largeAppStress.truncationMetadataCoverage.covered}/${summary.metrics.largeAppStress.truncationMetadataCoverage.total})`
      : 'Large app stress: not measured',
    summary.metrics.sessionStability?.enabled
      ? `Session stability: ${summary.metrics.sessionStability.success ? 'yes' : 'no'} (${summary.metrics.sessionStability.durationMs} ms, ${summary.metrics.sessionStability.commandCalls} probes)`
      : 'Session stability: not measured',
    summary.metrics.adversarialScenario?.enabled
      ? `Adversarial scenario: seed ${summary.metrics.adversarialScenario.seed}, class ${summary.metrics.adversarialScenario.targetClass}, traits ${summary.metrics.adversarialScenario.generatedCoverage.covered}/${summary.metrics.adversarialScenario.generatedCoverage.total}, exercised ${summary.metrics.adversarialScenario.exercisedCoverage.covered}/${summary.metrics.adversarialScenario.exercisedCoverage.total}`
      : 'Adversarial scenario: not measured',
    '',
  ];
  if (summary.metrics.adversarialScenario?.enabled && summary.metrics.adversarialScenario.replayCommand) {
    lines.push(`Adversarial replay: ${summary.metrics.adversarialScenario.replayCommand}`, '');
  }
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

export function buildKillerPathBenchmarkPlan(target, { stabilityMs = 1000, entrySteps = 'doctor-list', navUrl = null, adversarial = false } = {}) {
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
    { args: ['cascade', target, '#custom-clickable', 'cursor', '--format', 'json'], name: 'cascade-json', benchmarkProbe: true },
    { args: ['dismiss-modal', target, '--format', 'json', '--compact'] },
    { args: ['click', target, '#noop', '--format', 'json', '--compact'], name: 'no-change-json', benchmarkProbe: true },
    { args: ['fill', target, '#cmd', 'look trainer', '--format', 'json', '--compact'] },
    { args: ['click', target, '#combat', '--format', 'json', '--compact'] },
    { args: ['perceive', target, '--since-action', '--format', 'json'] },
    { args: ['report', target, '--last', '1', '--format', 'json', '--compact'] },
    { args: ['perceive', target, '-s', '#auth-panel', '-d', '4'], name: 'guarded-page' },
    { args: ['perceive', target, '-s', '#combat-log', '-d', '6', '--last', '20'], name: 'hmr-baseline' },
    { args: ['eval', target, hmrMutationScript], name: 'hmr-mutate' },
    { args: ['perceive', target, '--diff', '-s', '#combat-log', '-d', '6', '--last', '20'], name: 'hmr-diff' },
    ...(adversarial ? [
      { args: ['click', target, '#diagnostic', '--format', 'json', '--compact'], name: 'adversarial-slow-network', benchmarkProbe: true, timeout: 10000 },
      // Bound large-table proof to a row-count probe — dumping full TSV of 100+ rows
      // inflates total-output-tokens without improving the trait signal.
      { args: ['eval', target, 'document.querySelectorAll("#scenario-table tr").length'], name: 'adversarial-table', benchmarkProbe: true },
      { args: ['perceive', target, '-s', 'shadow-action-card', '-d', '4', '--adaptive'], name: 'adversarial-shadow', benchmarkProbe: true },
    ] : []),
    { args: ['inject', target, '--css', '#combat-log { outline: 2px solid rgb(37, 99, 235); }', '--format', 'json', '--compact'] },
    ...(actionEvidenceNavUrl ? [{ args: ['nav', target, actionEvidenceNavUrl, '--format', 'json', '--compact'] }] : []),
    { args: ['perceive', target, '-s', '#cmd', '-d', '4'], name: 'stale-ref-setup' },
    { args: ['reload', target, '--format', 'json', '--compact'], name: 'stale-ref-mutate' },
    { args: ['wait', target, '1000'], name: 'stale-ref-wait', timeout: 5000 },
    {
      args: ['click', target, '@1'],
      name: 'stale-ref',
      expectedFailure: true,
      expectedPattern: /Action failure: stale-ref|Unknown ref|Refs were (cleared|invalidated)|Next:\s*cdp perceive/i,
    },
    {
      args: ['click', target, '@1', '--format', 'json', '--compact'],
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
      { args: ['report', target, '--last', '1', '--format', 'json', '--compact'], name: 'stability-report' },
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

export async function runLargeAppStressBenchmark(opts = {}) {
  if (!opts.skipLock) {
    const port = Number(opts.port || process.env.CDP_LARGE_APP_BENCH_PORT || 9336);
    const serverPort = Number(opts.serverPort || process.env.CDP_LARGE_APP_BENCH_HTTP_PORT || 41740);
    return withLiveBenchmarkLock({
      name: 'benchmark:large-app',
      port,
      serverPort,
      browser: 'auto',
      profilePrefix: 'chrome-cdp-ex-large-app',
    }, run => runLargeAppStressBenchmark({
      ...opts,
      skipLock: true,
      port: run.metadata.port,
      serverPort: run.metadata.serverPort,
      profileDir: run.metadata.profileDir,
      liveRun: run,
    }));
  }
  const {
    port = Number(process.env.CDP_LARGE_APP_BENCH_PORT || 9336),
    serverPort = Number(process.env.CDP_LARGE_APP_BENCH_HTTP_PORT || 41740),
    json = false,
    profileDir: requestedProfileDir = null,
    liveRun = null,
  } = opts;
  if (!existsSync(cdp)) throw new Error(`cdp script not found: ${cdp}`);
  const candidates = browserCandidates();
  if (candidates.length === 0) throw new Error('no supported Chrome/Edge/Brave browser binary found');

  const [browserPath, browserName] = candidates[0];
  const profileDir = requestedProfileDir || mkdtempSync(resolve(tmpdir(), `chrome-cdp-ex-large-app-${browserName}-`));
  let browser;
  let server;
  const steps = [];
  let startedAt = Date.now();
  let target = '';

  const cleanup = () => {
    if (browser && !browser.killed) browser.kill('SIGTERM');
    if (server) server.close();
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  };

  try {
    const html = buildLargeAppStressHtml();
    server = createServer((req, res) => {
      if (req.url === '/' || req.url === '/large-app.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
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

    const url = `http://127.0.0.1:${serverPort}/large-app.html`;
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
    const open = await runStep({
      args: ['open', url, '--attach-timeout-ms', '5000', '--ready-timeout-ms', '5000', '--ready-selector', '[data-control="1"]', '--format', 'json'],
      timeout: 40000,
      env,
      steps,
      name: 'open',
      benchmarkProbe: true,
    });
    assertStep(open);
    const openModel = parseJsonOutput(outputText(open));
    target = openModel?.targetPrefix;
    if (!target) throw new Error(`open did not return a targetPrefix\nSTDOUT:\n${open.stdout}\nSTDERR:\n${open.stderr}`);

    for (const planned of [
      { args: ['perceive', target, ...LARGE_APP_PERCEIVE_ARGS], name: 'perceive', timeout: 40000 },
      { args: ['controls', target, '--limit', '30', '--format', 'json'], name: 'controls' },
      { args: ['text', target, '--auto'], name: 'text', timeout: 30000 },
      { args: ['table', target, '#accounts-grid'], name: 'table', timeout: 30000 },
      { args: ['summary', target, '--format', 'json'], name: 'summary' },
    ]) {
      const step = await runStep({ ...planned, env, steps });
      assertStep(step);
    }

    const summary = summarizeBenchmarkRun({
      scenario: 'large-app-stress',
      startedAt,
      endedAt: Date.now(),
      target,
      steps,
    });
    summary.browser = browserName;
    summary.port = port;
    summary.url = url;
    return json ? JSON.stringify(summary, null, 2) : formatBenchmarkReport(summary);
  } finally {
    cleanup();
  }
}

export function parseBenchmarkArgs(argv = []) {
  const opts = { json: false, stabilityMs: 1000, comparisonBaselinesPath: null, adversarialSeed: null, adversarialTraits: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') {
      opts.json = true;
    } else if (argv[i] === '--stability-ms') {
      const value = Number(argv[++i]);
      opts.stabilityMs = Number.isFinite(value) && value >= 0 ? value : opts.stabilityMs;
    } else if (argv[i] === '--comparison-baselines' || argv[i] === '--baseline-file') {
      opts.comparisonBaselinesPath = argv[++i] || null;
    } else if (argv[i] === '--adversarial-seed') {
      opts.adversarialSeed = normalizeAdversarialSeed(argv[++i]);
    } else if (argv[i] === '--adversarial-traits') {
      opts.adversarialTraits = normalizeAdversarialTraits(argv[++i]);
    }
  }
  return opts;
}

export async function runKillerPathBenchmark(opts = {}) {
  if (!opts.skipLock) {
    const port = Number(opts.port || process.env.CDP_BENCH_PORT || 9334);
    const serverPort = Number(opts.serverPort || process.env.CDP_BENCH_HTTP_PORT || 41738);
    return withLiveBenchmarkLock({
      name: 'benchmark:killer',
      port,
      serverPort,
      browser: 'auto',
      profilePrefix: 'chrome-cdp-ex-bench',
    }, run => runKillerPathBenchmark({
      ...opts,
      skipLock: true,
      port: run.metadata.port,
      serverPort: run.metadata.serverPort,
      profileDir: run.metadata.profileDir,
      liveRun: run,
    }));
  }
  const {
    port = Number(process.env.CDP_BENCH_PORT || 9334),
    serverPort = Number(process.env.CDP_BENCH_HTTP_PORT || 41738),
    json = false,
    stabilityMs = 1000,
    comparisonBaselinesPath = null,
    adversarialSeed = null,
    adversarialTraits = null,
    profileDir: requestedProfileDir = null,
    liveRun = null,
  } = opts;
  if (!existsSync(cdp)) throw new Error(`cdp script not found: ${cdp}`);
  if (!existsSync(page)) throw new Error(`smoke page not found: ${page}`);
  const candidates = browserCandidates();
  if (candidates.length === 0) throw new Error('no supported Chrome/Edge/Brave browser binary found');

  const [browserPath, browserName] = candidates[0];
  const profileDir = requestedProfileDir || mkdtempSync(resolve(tmpdir(), `chrome-cdp-ex-bench-${browserName}-`));
  let browser;
  let server;
  const steps = [];
  let startedAt = Date.now();
  let target = '';

  const cleanup = () => {
    if (browser && !browser.killed) browser.kill('SIGTERM');
    if (server) server.close();
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  };

  try {
    const adversarialScenario = adversarialSeed
      ? buildAdversarialScenario(adversarialSeed, { traits: adversarialTraits })
      : null;
    server = createServer((req, res) => {
      if (adversarialScenario && (req.url === '/' || req.url === adversarialScenario.path)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(adversarialScenario.html);
        return;
      }
      if (!adversarialScenario && (req.url === '/' || req.url === '/smoke-page.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(page));
        return;
      }
      if (adversarialScenario && req.url?.startsWith('/api/slow')) {
        const delay = Math.max(0, Math.min(2000, Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('delay') || adversarialScenario.slowNetworkMs || 0)));
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, seed: adversarialScenario.seed, delay }));
        }, delay);
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
    liveRun?.heartbeat();

    const url = adversarialScenario
      ? `http://127.0.0.1:${serverPort}${adversarialScenario.path}`
      : `http://127.0.0.1:${serverPort}/smoke-page.html`;
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

    // ponytail: benchmark the agent command path, not local browser cold-start variance.
    startedAt = Date.now();

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

    for (const planned of buildKillerPathBenchmarkPlan(target, { stabilityMs, entrySteps: 'none', navUrl: url, adversarial: Boolean(adversarialScenario) })) {
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
      adversarialScenario,
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
