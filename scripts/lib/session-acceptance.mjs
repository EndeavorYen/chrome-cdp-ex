// Pure helpers for scripts/verify-session-live.mjs, kept here so they can be tested without a browser.

// One `node session.mjs` child -> { status, ok, ms, result, error }. ok needs exit 0 AND receipt ok:true.
export function readReceipt({ status, stdout }) {
  let receipt;
  try {
    receipt = JSON.parse(String(stdout).trim());
  } catch {
    return { status, ok: false, ms: null, result: null, error: `no JSON receipt (exit ${status})` };
  }
  return {
    status,
    ok: status === 0 && receipt?.ok === true,
    ms: typeof receipt?.ms === 'number' ? receipt.ms : null,
    result: receipt?.result ?? null,
    error: receipt?.error ?? null,
  };
}

// The 12-step pass: every run ok and returned 12, and the receipt-ms median is within 300 ms.
export function twelveStepsPass(runs, summary) {
  return runs.length > 0 && runs.every((r) => r.ok && r.result === 12) && summary.median <= 300;
}
