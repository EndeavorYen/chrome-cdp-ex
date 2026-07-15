const TARGET_RESOLUTION_SCHEMA = 'chrome-cdp-ex.target-resolution.v1';

function matchingPages(requested, livePages) {
  const upper = String(requested || '').toUpperCase();
  return (livePages || []).filter(page => String(page?.targetId || '').toUpperCase().startsWith(upper));
}

export function resolveLiveTargetBinding({ requested, livePages = [], daemonBinding = null, alias = null } = {}) {
  const rawRequested = String(requested || '').trim();
  const requestedTarget = alias?.targetId || rawRequested;
  if (!requestedTarget) throw new Error('Target binding requires a requested target id or prefix.');
  const matches = alias?.targetId
    ? (livePages || []).filter(page => page?.targetId === alias.targetId)
    : matchingPages(requestedTarget, livePages);
  if (matches.length === 0) throw new Error(`No live target matching prefix "${rawRequested}".`);
  if (matches.length > 1) throw new Error(`Live target prefix "${rawRequested}" is ambiguous (${matches.length} matches).`);

  const resolvedTargetId = matches[0].targetId;
  const boundTargetId = daemonBinding?.boundTargetId || daemonBinding?.targetId || null;
  const rebindRequired = Boolean(boundTargetId && boundTargetId !== resolvedTargetId);
  return {
    schema: TARGET_RESOLUTION_SCHEMA,
    requestedTargetPrefix: rawRequested,
    requestedTargetId: alias?.targetId || resolvedTargetId,
    boundTargetId,
    resolvedTargetId,
    resolvedUrl: matches[0].url || '',
    resolvedTitle: matches[0].title || '',
    resolutionSource: alias ? 'live-discovery+alias' : 'live-discovery',
    status: rebindRequired ? 'rebind-required' : boundTargetId ? 'reused' : 'new-daemon',
    rebindRequired,
    rebound: false,
  };
}

export function completeTargetResolution(binding = {}, { boundTargetId = null, rebound = false } = {}) {
  return {
    ...binding,
    boundTargetId: boundTargetId || binding.resolvedTargetId || null,
    status: rebound ? 'rebound' : binding.boundTargetId ? 'reused' : 'started',
    rebindRequired: false,
    rebound,
  };
}

export function attachTargetResolutionDiagnostics(result, diagnostic) {
  if (!result || !diagnostic) return result;
  let parsed;
  try {
    parsed = typeof result === 'string' ? JSON.parse(result) : result;
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  const output = { ...parsed, targetResolution: diagnostic };
  return typeof result === 'string' ? JSON.stringify(output, null, 2) : output;
}

