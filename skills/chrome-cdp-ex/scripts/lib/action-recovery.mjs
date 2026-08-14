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
  const frameRef = String(input).match(/^(@f\d+):\d+$/)?.[1] || null;
  const perceiveCommand = frameRef
    ? `cdp perceive ${targetId} --frame ${frameRef}`
    : `cdp perceive ${targetId} -C -d 8`;
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
    lower.includes('is not a valid selector') ||
    lower.includes('invalid selector') ||
    lower.includes(':has-text(') ||
    lower.includes(':text(') ||
    lower.includes(':text-is(') ||
    (lower.includes('syntaxerror') && lower.includes('selector'))
  ) {
    const usage = `cdp ${action || 'click'} ${targetId} <css|#id|[data-testid]|@ref>`;
    return {
      ...base,
      kind: 'invalid-selector',
      reason: 'The selector is not valid CSS. Playwright text selectors like :has-text() are not supported.',
      nextCommand: usage,
      hints: [
        'Use a CSS selector, data-testid attribute, or an @ref from perceive — not Playwright :has-text()/ :text().',
        `Discover stable targets with \`${perceiveCommand}\` once, then click by @ref or CSS.`,
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

  if (
    lower.includes('not a fillable control')
    || lower.includes('not fillable')
  ) {
    return {
      ...base,
      kind: 'not-fillable',
      reason: 'fill requires an input, textarea, or contenteditable control.',
      nextCommand: `cdp help fill`,
      hints: [
        'Use fill on <input>, <textarea>, or contenteditable controls.',
        'Use click for links and buttons.',
      ],
    };
  }

  if (
    lower.includes('unknown key')
    || lower.includes('key name required')
  ) {
    return {
      ...base,
      kind: 'usage',
      reason: 'press requires a supported key name.',
      nextCommand: 'cdp help press',
      hints: [
        'Use Enter, Tab, Escape, Backspace, Space, Arrow*, or a single character.',
        'Use `type` for multi-character text.',
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

export function looksLikeClipboardControl(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (/^copy$/i.test(text)) return true;
  if (/\bclipboard\b/i.test(text)) return true;
  if (/\bcopied!?\b/i.test(text)) return true;
  return /\bcopy\b/i.test(text)
    && /\b(name|link|id|text|url|code|token|json|model|path|sha)\b/i.test(text);
}

export function isExpectedClipboardNoChange(target = {}, extraText = '') {
  if (target?.expectedOutcome === 'clipboard-no-change') return true;
  return looksLikeClipboardControl(target?.label)
    || looksLikeClipboardControl(target?.input)
    || looksLikeClipboardControl(target?.dispatchText)
    || looksLikeClipboardControl(extraText);
}

const NON_SELECTOR_RESOLVED_BY = new Set([
  'key', 'dialog', 'coordinates', 'scroll', 'history', 'url', 'viewport', 'focus', 'command',
]);

const NAMED_PRESS_KEYS = /^(enter|tab|escape|esc|space|backspace|shift|ctrl|control|alt|meta|arrow(up|down|left|right)|page(up|down)|home|end|delete|insert)$/i;

export function isExpectedPressNoChange(target = {}, action = null) {
  if (target?.expectedOutcome === 'press-no-change') return true;
  if (String(target?.resolvedBy || '') === 'key') return true;
  return String(action || target?.action || '').toLowerCase() === 'press';
}

export function isExpectedNoChange(target = {}, extraText = '', action = null) {
  if (isExpectedClipboardNoChange(target, extraText)) return true;
  if (target?.expectedOutcome === 'no-modal') return true;
  return isExpectedPressNoChange(target, action);
}

export function expectedNoChangeReason(target = {}, action = null) {
  if (isExpectedClipboardNoChange(target)) {
    return 'Clipboard / copy action; no visible AX tree change is expected.';
  }
  if (target?.expectedOutcome === 'no-modal') {
    return 'No visible modal/dialog was present; nothing was dismissed.';
  }
  if (isExpectedPressNoChange(target, action)) {
    return 'Key press produced no visible AX tree change; continue without overlay recovery.';
  }
  return 'No visible AX tree change observed after action.';
}

export function overlaySelectorArg(targetInput = '', targetInfo = {}) {
  const resolvedBy = String(targetInfo?.resolvedBy || '');
  if (NON_SELECTOR_RESOLVED_BY.has(resolvedBy)) return '';
  const raw = String(targetInput || targetInfo?.input || '').trim();
  if (!raw) return '';
  if (NAMED_PRESS_KEYS.test(raw)) return '';
  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(raw)) return '';
  if (/^modal$/i.test(raw)) return '';
  return recoveryCommandArg(raw);
}

function overlayCheckCommand(target, targetInput = '', targetInfo = {}) {
  const selector = overlaySelectorArg(targetInput, targetInfo);
  return selector
    ? `cdp overlay ${target} ${selector} --format json`
    : `cdp overlay ${target} --format json`;
}

function noChangeNeedsOverlay(action, targetInfo = {}) {
  if (isExpectedNoChange(targetInfo, '', action)) return false;
  return new Set(['click', 'jsclick', 'clickxy', 'fill', 'select', 'upload', 'press', 'dismiss-modal'])
    .has(String(action || '').toLowerCase());
}

function noChangeNeedsFrameContext(targetInput = '', targetInfo = {}) {
  const input = String(targetInput || targetInfo.input || '');
  return /^@f\d+:/i.test(input)
    || Boolean(targetInfo.frameRef)
    || Boolean(targetInfo.frameId)
    || targetInfo.resolvedBy === 'frame-ref';
}

function noChangeBlockingSignals({ action = null, targetInput = '', targetInfo = {} } = {}) {
  const signals = [];
  if (noChangeNeedsOverlay(action, targetInfo)) signals.push('overlay-check-needed');
  if (noChangeNeedsFrameContext(targetInput, targetInfo)) signals.push('frame-check-needed');
  if (!isExpectedNoChange(targetInfo, targetInput, action)) signals.push('fresh-perception-needed');
  return [...new Set(signals)];
}

function noChangeRecoveryHint(signals = []) {
  const topics = [];
  if (signals.includes('overlay-check-needed')) topics.push('overlays');
  if (signals.includes('frame-check-needed')) topics.push('frame context');
  if (signals.includes('fresh-perception-needed')) topics.push('fresh refs');
  const phrase = topics.length <= 1
    ? topics[0] || 'fresh page state'
    : `${topics.slice(0, -1).join(', ')} and ${topics.at(-1)}`;
  return `Action dispatched but produced no visible AX tree change; inspect ${phrase} before retrying.`;
}

export function buildNoChangeOutcomeRecommendation({
  action = null,
  actionIndex = null,
  target = '<target>',
  targetInput = '',
  targetInfo = {},
  source = 'action-outcome',
} = {}) {
  const blockingSignals = noChangeBlockingSignals({ action, targetInput, targetInfo });
  if (isExpectedNoChange(targetInfo, targetInput, action)) {
    const reason = isExpectedClipboardNoChange(targetInfo, targetInput)
      ? 'Clipboard / copy actions do not rewrite the AX tree; continue without overlay recovery.'
      : expectedNoChangeReason(targetInfo, action);
    const recoveryHint = isExpectedClipboardNoChange(targetInfo, targetInput)
      ? 'Clipboard action dispatched; no visible AX change is expected.'
      : targetInfo?.expectedOutcome === 'no-modal'
        ? 'No visible modal/dialog; continue without overlay recovery.'
        : 'Key press dispatched; no visible AX change is expected for a no-op key.';
    return {
      source,
      actionIndex,
      action,
      outcomeStatus: 'no-change',
      strategy: 'continue',
      priority: 'low',
      reason,
      blockingSignals,
      recoveryHint,
      verifyCommand: `cdp report ${target} --format json`,
      commands: uniqueNextStepCommands([`cdp report ${target} --format json`]),
    };
  }
  const overlayCommand = overlayCheckCommand(target, targetInput, targetInfo);
  const perceiveCommand = `cdp perceive ${target} -C -d 8`;
  const commands = [];
  if (blockingSignals.includes('overlay-check-needed')) commands.push(overlayCommand);
  if (blockingSignals.includes('frame-check-needed')) commands.push(`cdp frame ${target} --format json`);
  commands.push(perceiveCommand, `cdp report ${target} --format json`);
  return {
    source,
    actionIndex,
    action,
    outcomeStatus: 'no-change',
    strategy: 'investigate-no-change',
    priority: 'medium',
    reason: 'The action dispatched but produced no visible AX tree change; check blockers, frame context, or refreshed refs before retrying.',
    blockingSignals,
    recoveryHint: noChangeRecoveryHint(blockingSignals),
    verifyCommand: perceiveCommand,
    commands: uniqueNextStepCommands(commands),
  };
}

/**
 * Data-driven recovery policy registry.
 * Templates describe strategy/priority/verify + ordered command intents.
 * Concrete CLI strings are resolved in buildActionRecoveryPlan().
 */
export const RECOVERY_POLICY_REGISTRY = Object.freeze({
  'network-failure': {
    strategy: 'inspect-network',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'netlog', reason: 'Inspect failed or pending requests caused by the action.' },
      { key: 'since-action', reason: 'Verify what the action changed before retrying.' },
      { key: 'report', reason: 'Preserve the action timeline and diagnostics for handoff.' },
    ],
    avoid: ['retrying the same action before checking network state'],
  },
  'network-pending': {
    strategy: 'inspect-network',
    priority: 'medium',
    verify: 'since-action',
    intents: [
      { key: 'netlog', reason: 'Inspect failed or pending requests caused by the action.' },
      { key: 'since-action', reason: 'Verify what the action changed before retrying.' },
      { key: 'report', reason: 'Preserve the action timeline and diagnostics for handoff.' },
    ],
    avoid: ['retrying the same action before checking network state'],
  },
  exception: {
    strategy: 'inspect-runtime-errors',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'console', reason: 'Inspect page errors triggered by the action.' },
      { key: 'since-action', reason: 'Verify visible UI changes from the action.' },
      { key: 'report', reason: 'Preserve the action timeline and diagnostics for handoff.' },
    ],
    avoid: [],
  },
  'console-error': {
    strategy: 'inspect-runtime-errors',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'console', reason: 'Inspect page errors triggered by the action.' },
      { key: 'since-action', reason: 'Verify visible UI changes from the action.' },
      { key: 'report', reason: 'Preserve the action timeline and diagnostics for handoff.' },
    ],
    avoid: [],
  },
  overlay: {
    strategy: 'clear-overlay',
    priority: 'high',
    verify: 'perceive',
    intents: [
      { key: 'overlay', reason: 'Confirm which overlay or dialog blocks the target.' },
      { key: 'next-or-dismiss', reason: 'Dismiss the blocking modal or overlay safely.' },
      { key: 'perceive', reason: 'Refresh refs after the overlay changes.' },
    ],
    avoid: ['retrying the same click before clearing or re-checking the overlay'],
  },
  'wrong-frame': {
    strategy: 'refresh-frame-context',
    priority: 'high',
    verify: 'next-or-perceive',
    intents: [
      { key: 'frame', reason: 'List frames and choose the correct frame context.' },
      { key: 'next-or-perceive', reason: 'Refresh page perception before using refs again.' },
    ],
    avoid: ['retrying top-level refs when the control may be inside an iframe'],
  },
  'stale-ref': {
    strategy: 'refresh-perception',
    priority: 'high',
    verify: 'next-or-perceive',
    intents: [
      { key: 'next-or-perceive', reason: 'Refresh current controls and refs.' },
      { key: 'status', reason: 'Check navigation, console, and target health if the page changed.' },
    ],
    avoid: ['retrying stale @refs before refreshing perception'],
  },
  'dom-rewrite': {
    strategy: 'refresh-perception',
    priority: 'high',
    verify: 'next-or-perceive',
    intents: [
      { key: 'next-or-perceive', reason: 'Refresh current controls and refs.' },
      { key: 'status', reason: 'Check navigation, console, and target health if the page changed.' },
    ],
    avoid: ['retrying stale @refs before refreshing perception'],
  },
  navigation: {
    strategy: 'refresh-perception',
    priority: 'high',
    verify: 'next-or-perceive',
    intents: [
      { key: 'next-or-perceive', reason: 'Refresh current controls and refs.' },
      { key: 'status', reason: 'Check navigation, console, and target health if the page changed.' },
    ],
    avoid: ['retrying stale @refs before refreshing perception'],
  },
  selector: {
    strategy: 'refresh-perception',
    priority: 'medium',
    verify: 'next-or-perceive',
    intents: [
      { key: 'next-or-perceive', reason: 'Refresh current controls and refs.' },
      { key: 'status', reason: 'Check navigation, console, and target health if the page changed.' },
    ],
    avoid: ['retrying stale @refs before refreshing perception'],
  },
  timeout: {
    strategy: 'check-tab-health',
    priority: 'medium',
    verify: 'status',
    intents: [
      { key: 'next-or-status', reason: 'Check whether the tab and CDP session are still responsive.' },
      { key: 'since-action', reason: 'If dispatch may have happened, inspect the last-action diff.' },
      { key: 'report', reason: 'Preserve any partial diagnostics already captured.' },
    ],
    avoid: [],
  },
  'observation-timeout': {
    strategy: 'check-tab-health',
    priority: 'medium',
    verify: 'status',
    intents: [
      { key: 'next-or-status', reason: 'Check whether the tab and CDP session are still responsive.' },
      { key: 'since-action', reason: 'If dispatch may have happened, inspect the last-action diff.' },
      { key: 'report', reason: 'Preserve any partial diagnostics already captured.' },
    ],
    avoid: [],
  },
  'observation-error': {
    strategy: 'check-tab-health',
    priority: 'medium',
    verify: 'status',
    intents: [
      { key: 'next-or-status', reason: 'Check whether the tab and CDP session are still responsive.' },
      { key: 'since-action', reason: 'If dispatch may have happened, inspect the last-action diff.' },
      { key: 'report', reason: 'Preserve any partial diagnostics already captured.' },
    ],
    avoid: [],
  },
  default: {
    strategy: 'refresh-perception',
    priority: 'medium',
    verify: 'next-or-perceive',
    intents: [
      { key: 'next-or-perceive', reason: 'Refresh perception before choosing the next action.' },
    ],
    avoid: [],
  },
});

export function listRecoveryPolicyKinds() {
  return Object.keys(RECOVERY_POLICY_REGISTRY).filter(kind => kind !== 'default').sort();
}

export function getRecoveryPolicyTemplate(kind) {
  return RECOVERY_POLICY_REGISTRY[kind] || RECOVERY_POLICY_REGISTRY.default;
}

export function buildActionRecoveryPlan(diagnosis = {}, { targetId = '<target>', targetInput = '' } = {}) {
  const target = targetId || '<target>';
  const commandMap = {
    perceive: `cdp perceive ${target} -C -d 8`,
    'since-action': `cdp perceive ${target} --since-action`,
    status: `cdp status ${target}`,
    report: `cdp report ${target} --format json`,
    netlog: `cdp netlog ${target}`,
    console: `cdp console ${target} --errors`,
    frame: `cdp frame ${target} --format json`,
    overlay: overlayCheckCommand(target, targetInput),
    dismiss: `cdp dismiss-modal ${target}`,
  };
  const nextCommand = diagnosis.nextCommand || null;
  const resolveIntent = (key) => {
    if (key === 'next-or-dismiss') return nextCommand || commandMap.dismiss;
    if (key === 'next-or-perceive') return nextCommand || commandMap.perceive;
    if (key === 'next-or-status') return nextCommand || commandMap.status;
    return commandMap[key] || null;
  };
  const template = getRecoveryPolicyTemplate(diagnosis.kind);
  const priority = diagnosis.status === 'blocked'
    ? 'high'
    : (template.priority || 'medium');
  const commands = uniqueRecoveryCommands(
    (template.intents || []).map(intent => {
      const command = resolveIntent(intent.key);
      return command ? recoveryCommand(command, intent.reason) : null;
    }).filter(Boolean),
  );
  const verifyKey = template.verify || 'perceive';
  const verifyCommand = resolveIntent(verifyKey) || commandMap.perceive;
  return {
    schema: 'chrome-cdp-ex.recovery-policy.v1',
    strategy: template.strategy || 'refresh-perception',
    priority,
    commands,
    verifyCommand,
    avoid: Array.isArray(template.avoid) ? [...template.avoid] : [],
    kind: diagnosis.kind || 'unknown',
  };
}

export function recoveryCommandsFromDiagnosis(diagnosis = null) {
  const commands = diagnosis?.recovery?.commands;
  if (Array.isArray(commands) && commands.length) {
    return commands.map(entry => entry?.command).filter(Boolean);
  }
  return diagnosis?.nextCommand ? [diagnosis.nextCommand] : [];
}
