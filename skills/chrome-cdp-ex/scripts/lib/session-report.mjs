import {
  actionFailureInput,
  actionTargetCommandId,
  buildNoChangeOutcomeRecommendation,
  recoveryCommandsFromDiagnosis,
  uniqueNextStepCommands,
} from './action-recovery.mjs';

function escapeRegExpLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeReportTargetCommand(command, fromTarget, toTarget) {
  if (!command || !fromTarget || !toTarget || fromTarget === toTarget) return command;
  const re = new RegExp(`^(cdp\\s+\\S+\\s+)${escapeRegExpLiteral(fromTarget)}(?=$|\\s)`);
  return String(command).replace(re, `$1${toTarget}`);
}

export function normalizeReportTargetCommands(commands = [], fromTarget, toTarget) {
  return uniqueNextStepCommands(commands.map(command => normalizeReportTargetCommand(command, fromTarget, toTarget)));
}

export function defaultReportNextSteps(target, hasActions) {
  return hasActions
    ? [
        `cdp perceive ${target} --since-action`,
        `cdp record-actions ${target} --format json`,
        `cdp export-playwright ${target}`,
      ]
    : [
        `cdp perceive ${target} -C -d 8`,
        `cdp click ${target} @ref  # choose a ref from perceive`,
      ];
}

export function buildReportRecommendation(actionLog = [], target, fullTarget = target) {
  for (let i = actionLog.length - 1; i >= 0; i--) {
    const entry = actionLog[i];
    const diagnosis = entry?.diagnosis || null;
    if (!diagnosis || diagnosis.status === 'ok') continue;
    const recovery = diagnosis.recovery || null;
    const sourceTarget = actionTargetCommandId(entry.target || {}) || fullTarget;
    const commands = normalizeReportTargetCommands(recoveryCommandsFromDiagnosis(diagnosis), sourceTarget, target);
    const verifyCommand = normalizeReportTargetCommand(recovery?.verifyCommand || diagnosis.nextCommand || null, sourceTarget, target);
    return {
      source: 'latest-action-diagnosis',
      actionIndex: i + 1,
      action: entry.action || null,
      diagnosisKind: diagnosis.kind || null,
      strategy: recovery?.strategy || null,
      priority: recovery?.priority || null,
      verifyCommand,
      commands,
    };
  }
  for (let i = actionLog.length - 1; i >= 0; i--) {
    const entry = actionLog[i];
    if (entry?.outcome?.status !== 'no-change') continue;
    const sourceTarget = actionTargetCommandId(entry.target || {}) || fullTarget;
    const recommendation = buildNoChangeOutcomeRecommendation({
      source: 'latest-action-outcome',
      actionIndex: i + 1,
      action: entry.action || null,
      target: sourceTarget,
      targetInput: actionFailureInput(entry.target || {}),
    });
    return {
      ...recommendation,
      verifyCommand: normalizeReportTargetCommand(recommendation.verifyCommand || null, sourceTarget, target),
      commands: normalizeReportTargetCommands(recommendation.commands || [], sourceTarget, target),
    };
  }
  return {
    source: actionLog.length > 0 ? 'session-continuation' : 'onboarding',
    actionIndex: null,
    action: null,
    diagnosisKind: null,
    strategy: actionLog.length > 0 ? 'continue-or-export' : 'perceive-first',
    priority: 'medium',
    verifyCommand: actionLog.length > 0 ? `cdp perceive ${target} --since-action` : `cdp perceive ${target} -C -d 8`,
    commands: defaultReportNextSteps(target, actionLog.length > 0),
  };
}

export function formatReportRecommendationLines(recommendation = {}) {
  const commands = recommendation.commands || [];
  const run = commands[0] || recommendation.verifyCommand || null;
  const lines = ['Recommendation:'];
  if (recommendation.source) lines.push(`  Source: ${recommendation.source}`);
  if (recommendation.actionIndex != null) lines.push(`  Action: #${recommendation.actionIndex}${recommendation.action ? ` ${recommendation.action}` : ''}`);
  if (recommendation.diagnosisKind) lines.push(`  Diagnosis: ${recommendation.diagnosisKind}`);
  if (recommendation.outcomeStatus) lines.push(`  Outcome: ${recommendation.outcomeStatus}`);
  if (recommendation.strategy) lines.push(`  Strategy: ${recommendation.strategy}`);
  if (recommendation.priority) lines.push(`  Priority: ${recommendation.priority}`);
  if (run) lines.push(`  Run: ${run}`);
  if (recommendation.verifyCommand) lines.push(`  Verify: ${recommendation.verifyCommand}`);
  return lines;
}

export function formatReportNextStepLines(nextSteps = []) {
  const lines = ['Next steps:'];
  if (!nextSteps.length) {
    lines.push('  1. cdp perceive <target> -C -d 8');
    return lines;
  }
  for (const [index, command] of nextSteps.entries()) {
    lines.push(`  ${index + 1}. ${command}`);
  }
  return lines;
}
