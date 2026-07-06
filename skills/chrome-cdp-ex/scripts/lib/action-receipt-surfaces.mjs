function isSignalDeltaDetail(detail = {}) {
  if (!detail || typeof detail !== 'object') return false;
  if (detail.status && detail.status !== 'unchanged') return true;
  return ['count', 'errors', 'warnings', 'failures', 'pending'].some(key => Number(detail[key] || 0) > 0);
}

export function compactDeltaDetailsForHandoff(details = []) {
  const items = Array.isArray(details) ? details.filter(detail => detail && typeof detail === 'object') : [];
  const signalItems = items.filter(isSignalDeltaDetail);
  return signalItems.length ? signalItems : items.slice(0, 1);
}

export function compactObservedDeltaLinesForHandoff(lines = []) {
  const items = Array.isArray(lines) ? lines.filter(line => typeof line === 'string' && line.trim()) : [];
  const signalItems = items.filter(line => !/^(Console|Exceptions|Network) unchanged$/i.test(line.trim()));
  return signalItems.length ? signalItems : items.slice(0, 1);
}

function settlementForActionJson(settlement = null) {
  if (!settlement || typeof settlement !== 'object') return settlement;
  const compact = {
    ok: settlement.ok ?? null,
    state: settlement.state || null,
    strategy: settlement.strategy || null,
    durationMs: Number.isFinite(settlement.durationMs) ? settlement.durationMs : null,
    observedChannels: Array.isArray(settlement.observedChannels) ? settlement.observedChannels : [],
    signals: Array.isArray(settlement.signals) ? settlement.signals : [],
  };
  if (settlement.reason && settlement.state !== 'settled') compact.reason = settlement.reason;
  if (Number.isFinite(settlement.timeoutMs)) {
    compact.timeoutMs = settlement.timeoutMs;
  }
  return compact;
}

function settlementForReport(settlement = null) {
  if (!settlement || typeof settlement !== 'object') return null;
  return {
    state: settlement.state || null,
    strategy: settlement.strategy || null,
    durationMs: Number.isFinite(settlement.durationMs) ? settlement.durationMs : null,
    signals: Array.isArray(settlement.signals) ? settlement.signals : [],
  };
}

export function receiptForActionJson(receipt = null) {
  if (!receipt || typeof receipt !== 'object') return receipt;
  return {
    schema: receipt.schema || 'chrome-cdp-ex.action-receipt.v1',
    actionId: receipt.actionId || null,
    eventId: receipt.eventId || null,
    sequence: receipt.sequence ?? null,
    loggedAt: receipt.loggedAt || null,
    dispatch: receipt.dispatch || null,
    settlement: settlementForActionJson(receipt.settlement),
    outcome: receipt.outcome || null,
    observedDelta: compactObservedDeltaLinesForHandoff(receipt.observedDelta),
    observedDeltaDetails: compactDeltaDetailsForHandoff(receipt.observedDeltaDetails),
    blockingSignals: Array.isArray(receipt.blockingSignals) ? receipt.blockingSignals : [],
    recoveryHint: receipt.recoveryHint || null,
    nextSteps: Array.isArray(receipt.nextSteps) ? receipt.nextSteps : [],
  };
}

export function receiptForReport(receipt = null) {
  if (!receipt || typeof receipt !== 'object') return null;
  return {
    schema: receipt.schema || 'chrome-cdp-ex.action-receipt.v1',
    actionId: receipt.actionId || null,
    eventId: receipt.eventId || null,
    sequence: receipt.sequence ?? null,
    loggedAt: receipt.loggedAt || null,
    settlement: settlementForReport(receipt.settlement),
    outcome: receipt.outcome || null,
    observedDeltaDetails: compactDeltaDetailsForHandoff(receipt.observedDeltaDetails),
    blockingSignals: Array.isArray(receipt.blockingSignals) ? receipt.blockingSignals : [],
    recoveryHint: receipt.recoveryHint || null,
  };
}
