export function isTimeoutError(err, methods = []) {
  const msg = err?.message || String(err || '');
  if (!msg.startsWith('Timeout:')) return false;
  return methods.length === 0 || methods.some(method => msg.includes(method));
}

export function actionFailureMessage(err) {
  return err?.message || String(err || '');
}

export function actionFailureTargetId(target = {}) {
  return target?.targetId || target?.id || target?.target || '<target>';
}

export function actionFailureInput(target = {}) {
  return target?.input || target?.label || target?.selector || '';
}

export function actionTargetCommandId(target = {}) {
  return actionFailureTargetId(target);
}

export function actionTargetCommandPrefix(target = {}) {
  const id = String(actionTargetCommandId(target) || '');
  if (!id || id === '<target>') return '<target>';
  return id.slice(0, 8);
}

export function classifyActionFailure(err, { action = 'action', target = {} } = {}) {
  const originalMessage = actionFailureMessage(err);
  const lower = originalMessage.toLowerCase();
  const targetId = actionFailureTargetId(target);
  const input = actionFailureInput(target);
  const perceiveCommand = `cdp perceive ${targetId} -C -d 8`;
  const statusCommand = `cdp status ${targetId}`;
  const base = {
    schema: 'chrome-cdp-ex.action-failure.v1',
    action,
    target: target || null,
    originalMessage,
    kind: 'unknown',
    reason: 'The browser rejected the action for a reason chrome-cdp-ex does not classify yet.',
    nextCommand: perceiveCommand,
    hints: [`Refresh page perception with \`${perceiveCommand}\`, then choose the next action from fresh refs.`],
  };

  if (lower.includes('unknown ref') || lower.includes('refs were cleared') || lower.includes('refs were invalidated')) {
    return {
      ...base,
      kind: 'stale-ref',
      reason: 'The @ref no longer maps to the current DOM.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh refs with \`${perceiveCommand}\`.`,
        'Use a stable CSS selector instead of @ref for long loops or replayable workflows.',
      ],
    };
  }

  if (
    lower.includes('other element would receive') ||
    lower.includes('click intercepted') ||
    lower.includes('intercepted by another element') ||
    lower.includes('hit test') ||
    lower.includes('not clickable at point')
  ) {
    const jsClick = input ? `cdp jsclick ${targetId} ${input}` : null;
    return {
      ...base,
      kind: 'overlay',
      reason: 'A visible overlay or hit-test interception blocked the realistic mouse action.',
      nextCommand: `cdp dismiss-modal ${targetId}`,
      hints: [
        `Close obvious dialogs or overlays with \`cdp dismiss-modal ${targetId}\`.`,
        `Refresh refs after the overlay changes with \`${perceiveCommand}\`.`,
        ...(jsClick ? [`If the overlay is intentional and the target is still correct, try \`${jsClick}\`.`] : []),
      ],
    };
  }

  if (
    lower.includes('no frame for given id') ||
    lower.includes('frame was detached') ||
    lower.includes('target frame detached') ||
    lower.includes('wrong frame')
  ) {
    return {
      ...base,
      kind: 'wrong-frame',
      reason: 'The action targeted a frame or execution context that is no longer current.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh page and frame context with \`${perceiveCommand}\`.`,
        'If the control is inside an iframe, prefer a fresh perceive/coordinate target until frame-scoped refs are available.',
      ],
    };
  }

  if (
    lower.includes('cannot find context') ||
    lower.includes('execution context was destroyed') ||
    lower.includes('inspected target navigated') ||
    lower.includes('target closed')
  ) {
    return {
      ...base,
      kind: 'navigation',
      reason: 'The page navigated, reloaded, or recreated its JavaScript context during the action.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh the current page state with \`${perceiveCommand}\`.`,
        `Use \`cdp status ${targetId}\` if navigation or console failures may explain the change.`,
      ],
    };
  }

  if (
    lower.includes('no node with given id') ||
    lower.includes('could not find node') ||
    lower.includes('node is detached from document') ||
    lower.includes('cannot find node with given id')
  ) {
    return {
      ...base,
      kind: 'dom-rewrite',
      reason: 'The DOM node disappeared or was rewritten after it was resolved.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh refs with \`${perceiveCommand}\`.`,
        'For React/Vue rerenders or HMR, prefer a stable CSS selector over an old @ref.',
      ],
    };
  }

  if (isTimeoutError(err) || lower.includes('timed out') || lower.includes('timeout')) {
    return {
      ...base,
      kind: 'timeout',
      reason: 'The action or its CDP acknowledgement exceeded the timeout window.',
      nextCommand: statusCommand,
      hints: [
        `Check whether the tab is still responsive with \`${statusCommand}\`.`,
        `If the action may have dispatched, run \`cdp perceive ${targetId} --since-action\` before retrying.`,
      ],
    };
  }

  if (
    lower.includes('element not found') ||
    lower.includes('could not resolve selector') ||
    lower.includes('failed to find element')
  ) {
    return {
      ...base,
      kind: 'selector',
      reason: 'No current element matched the requested selector/ref.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh available controls with \`${perceiveCommand}\`.`,
        'Check whether the element is below the fold, inside a modal, or renamed by the framework.',
      ],
    };
  }

  return base;
}

export function formatActionFailure(err, context = {}) {
  const message = actionFailureMessage(err);
  if (message.startsWith('Action failure:')) return message;
  const failure = classifyActionFailure(err, context);
  const lines = [
    `Action failure: ${failure.kind}`,
    `Reason: ${failure.reason}`,
    `Next: ${failure.nextCommand}`,
  ];
  for (const hint of failure.hints || []) lines.push(`Hint: ${hint}`);
  lines.push(`Original: ${failure.originalMessage}`);
  return lines.join('\n');
}

export function recoveryCommandArg(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^@[a-z0-9:]+$/i.test(text)) return text;
  if (text.startsWith('#')) return JSON.stringify(text);
  if (/^[^\s"'`\\$]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function recoveryCommand(command, reason) {
  return { command, reason };
}

function uniqueRecoveryCommands(commands = []) {
  const seen = new Set();
  const out = [];
  for (const entry of commands) {
    if (!entry?.command || seen.has(entry.command)) continue;
    seen.add(entry.command);
    out.push(entry);
  }
  return out;
}

export function uniqueNextStepCommands(commands = []) {
  const out = [];
  for (const command of commands) {
    if (!command || out.includes(command)) continue;
    out.push(command);
  }
  return out;
}

export function buildNoChangeOutcomeRecommendation({
  action = null,
  actionIndex = null,
  target = '<target>',
  targetInput = '',
  source = 'action-outcome',
} = {}) {
  const input = recoveryCommandArg(targetInput);
  const overlayCommand = input ? `cdp overlay ${target} ${input} --format json` : `cdp overlay ${target} --format json`;
  const perceiveCommand = `cdp perceive ${target} -C -d 8`;
  return {
    source,
    actionIndex,
    action,
    outcomeStatus: 'no-change',
    strategy: 'investigate-no-change',
    priority: 'medium',
    reason: 'The action dispatched but produced no visible AX tree change; check blockers, frame context, or refreshed refs before retrying.',
    verifyCommand: perceiveCommand,
    commands: uniqueNextStepCommands([
      overlayCommand,
      `cdp frame ${target} --format json`,
      perceiveCommand,
      `cdp report ${target} --format json`,
    ]),
  };
}

export function buildActionRecoveryPlan(diagnosis = {}, { targetId = '<target>', targetInput = '' } = {}) {
  const target = targetId || '<target>';
  const input = recoveryCommandArg(targetInput);
  const perceiveCommand = `cdp perceive ${target} -C -d 8`;
  const sinceActionCommand = `cdp perceive ${target} --since-action`;
  const statusCommand = `cdp status ${target}`;
  const reportCommand = `cdp report ${target} --format json`;
  const netlogCommand = `cdp netlog ${target}`;
  const consoleCommand = `cdp console ${target} --errors`;
  const frameCommand = `cdp frame ${target} --format json`;
  const overlayCommand = input ? `cdp overlay ${target} ${input} --format json` : `cdp overlay ${target} --format json`;
  const dismissCommand = `cdp dismiss-modal ${target}`;
  const nextCommand = diagnosis.nextCommand || null;
  const base = {
    schema: 'chrome-cdp-ex.recovery-policy.v1',
    strategy: 'refresh-perception',
    priority: diagnosis.status === 'blocked' ? 'high' : 'medium',
    commands: [],
    verifyCommand: perceiveCommand,
    avoid: [],
  };

  switch (diagnosis.kind) {
    case 'network-failure':
    case 'network-pending':
      return {
        ...base,
        strategy: 'inspect-network',
        priority: diagnosis.kind === 'network-failure' ? 'high' : 'medium',
        commands: uniqueRecoveryCommands([
          recoveryCommand(netlogCommand, 'Inspect failed or pending requests caused by the action.'),
          recoveryCommand(sinceActionCommand, 'Verify what the action changed before retrying.'),
          recoveryCommand(reportCommand, 'Preserve the action timeline and diagnostics for handoff.'),
        ]),
        verifyCommand: sinceActionCommand,
        avoid: ['retrying the same action before checking network state'],
      };
    case 'exception':
    case 'console-error':
      return {
        ...base,
        strategy: 'inspect-runtime-errors',
        priority: 'high',
        commands: uniqueRecoveryCommands([
          recoveryCommand(consoleCommand, 'Inspect page errors triggered by the action.'),
          recoveryCommand(sinceActionCommand, 'Verify visible UI changes from the action.'),
          recoveryCommand(reportCommand, 'Preserve the action timeline and diagnostics for handoff.'),
        ]),
        verifyCommand: sinceActionCommand,
      };
    case 'overlay':
      return {
        ...base,
        strategy: 'clear-overlay',
        priority: 'high',
        commands: uniqueRecoveryCommands([
          recoveryCommand(overlayCommand, 'Confirm which overlay or dialog blocks the target.'),
          recoveryCommand(nextCommand || dismissCommand, 'Dismiss the blocking modal or overlay safely.'),
          recoveryCommand(perceiveCommand, 'Refresh refs after the overlay changes.'),
        ]),
        verifyCommand: perceiveCommand,
        avoid: ['retrying the same click before clearing or re-checking the overlay'],
      };
    case 'wrong-frame':
      return {
        ...base,
        strategy: 'refresh-frame-context',
        priority: 'high',
        commands: uniqueRecoveryCommands([
          recoveryCommand(frameCommand, 'List frames and choose the correct frame context.'),
          recoveryCommand(nextCommand || perceiveCommand, 'Refresh page perception before using refs again.'),
        ]),
        verifyCommand: nextCommand || perceiveCommand,
        avoid: ['retrying top-level refs when the control may be inside an iframe'],
      };
    case 'stale-ref':
    case 'dom-rewrite':
    case 'navigation':
    case 'selector':
      return {
        ...base,
        strategy: 'refresh-perception',
        priority: diagnosis.kind === 'selector' ? 'medium' : 'high',
        commands: uniqueRecoveryCommands([
          recoveryCommand(nextCommand || perceiveCommand, 'Refresh current controls and refs.'),
          recoveryCommand(statusCommand, 'Check navigation, console, and target health if the page changed.'),
        ]),
        verifyCommand: nextCommand || perceiveCommand,
        avoid: ['retrying stale @refs before refreshing perception'],
      };
    case 'timeout':
    case 'observation-timeout':
      return {
        ...base,
        strategy: 'check-tab-health',
        priority: 'medium',
        commands: uniqueRecoveryCommands([
          recoveryCommand(nextCommand || statusCommand, 'Check whether the tab and CDP session are still responsive.'),
          recoveryCommand(sinceActionCommand, 'If dispatch may have happened, inspect the last-action diff.'),
          recoveryCommand(reportCommand, 'Preserve any partial diagnostics already captured.'),
        ]),
        verifyCommand: statusCommand,
      };
    default:
      return {
        ...base,
        commands: uniqueRecoveryCommands([
          recoveryCommand(nextCommand || perceiveCommand, 'Refresh perception before choosing the next action.'),
        ]),
        verifyCommand: nextCommand || perceiveCommand,
      };
  }
}

export function recoveryCommandsFromDiagnosis(diagnosis = null) {
  const commands = diagnosis?.recovery?.commands;
  if (Array.isArray(commands) && commands.length) {
    return commands.map(entry => entry?.command).filter(Boolean);
  }
  return diagnosis?.nextCommand ? [diagnosis.nextCommand] : [];
}
