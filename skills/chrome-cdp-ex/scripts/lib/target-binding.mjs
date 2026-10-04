const TARGET_RESOLUTION_SCHEMA = 'chrome-cdp-ex.target-resolution.v1';

function matchingPages(requested, livePages) {
  const upper = String(requested || '').toUpperCase();
  return (livePages || []).filter(page => String(page?.targetId || '').toUpperCase().startsWith(upper));
}

function matchingAliasPages(alias, livePages) {
  const wanted = String(alias?.targetId || '').toUpperCase();
  if (!wanted) return [];
  const exact = (livePages || []).filter(page => String(page?.targetId || '').toUpperCase() === wanted);
  if (exact.length) return exact;
  return matchingPages(wanted, livePages);
}

// The shortest prefix (at least 8 characters) that names only this target among the live pages.
function uniqueLivePrefix(targetId, livePages) {
  const id = String(targetId || '');
  const others = (livePages || []).map(page => String(page?.targetId || '').toUpperCase()).filter(other => other !== id.toUpperCase());
  for (let len = 8; len < id.length; len++) {
    const prefix = id.slice(0, len).toUpperCase();
    if (!others.some(other => other.startsWith(prefix))) return id.slice(0, len);
  }
  return id;
}

// #538: Chrome can hand a tab a new target id without the tab closing (a renderer swap, a
// cross-process navigation). When the vanished prefix had exactly one entry in the page list last
// written to pages.json, and exactly one live page has that entry's URL and title, that page is
// almost certainly the same tab. Name it; never re-bind to it.
function findSuccessorPage(requested, lastSeenPages, livePages) {
  const upper = String(requested || '').toUpperCase();
  const seen = (lastSeenPages || []).filter(page => String(page?.targetId || '').toUpperCase().startsWith(upper));
  if (seen.length !== 1 || !seen[0].url) return null;
  const { url, title = '' } = seen[0];
  const candidates = (livePages || []).filter(page => page?.url === url
    && (page?.title || '') === title
    && !String(page?.targetId || '').toUpperCase().startsWith(upper));
  return candidates.length === 1 ? candidates[0] : null;
}

export function resolveLiveTargetBinding({ requested, livePages = [], daemonBinding = null, alias = null, lastSeenPages = [] } = {}) {
  const rawRequested = String(requested || '').trim();
  const requestedTarget = alias?.targetId || rawRequested;
  if (!requestedTarget) throw new Error('Target binding requires a requested target id or prefix.');
  const matches = alias?.targetId
    ? matchingAliasPages(alias, livePages)
    : matchingPages(requestedTarget, livePages);
  if (matches.length === 0) {
    if (alias?.name) {
      throw new Error(`No live target matching alias @${alias.name} (prefix ${String(alias.targetId || rawRequested).slice(0, 8)}). Run: cdp list`);
    }
    const successor = findSuccessorPage(rawRequested, lastSeenPages, livePages);
    if (successor) {
      const successorPrefix = uniqueLivePrefix(successor.targetId, livePages);
      const error = new Error(`No live target matching prefix "${rawRequested}". Target ${rawRequested} is gone; the same page (same URL and title) is now ${successorPrefix}: ${successor.url}`);
      error.code = 'target_successor';
      error.successorTargetId = successor.targetId;
      error.successorPrefix = successorPrefix;
      throw error;
    }
    throw new Error(`No live target matching prefix "${rawRequested}".`);
  }
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
