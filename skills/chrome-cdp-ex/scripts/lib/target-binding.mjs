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
  const stableTargetId = diagnostic.resolvedTargetId || null;
  const canCollapseStableTarget = parsed.mode === 'compact'
    && stableTargetId
    && diagnostic.requestedTargetId === stableTargetId
    && diagnostic.boundTargetId === stableTargetId
    && diagnostic.rebound !== true;
  const targetResolution = canCollapseStableTarget ? {
    requestedTargetPrefix: diagnostic.requestedTargetPrefix || null,
    targetId: stableTargetId,
    status: diagnostic.status || null,
    rebound: false,
  } : {
    requestedTargetPrefix: diagnostic.requestedTargetPrefix || null,
    requestedTargetId: diagnostic.requestedTargetId || null,
    boundTargetId: diagnostic.boundTargetId || null,
    resolvedTargetId: diagnostic.resolvedTargetId || null,
    resolutionSource: diagnostic.resolutionSource || null,
    status: diagnostic.status || null,
    rebound: diagnostic.rebound === true,
  };
  const output = { ...parsed, targetResolution };
  if (typeof result !== 'string') return output;
  return parsed.mode === 'compact' ? JSON.stringify(output) : JSON.stringify(output, null, 2);
}
