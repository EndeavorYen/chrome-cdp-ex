# Action Receipt Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize settlement semantics and receipt handoff surfaces without changing core browser action behavior.

**Architecture:** Keep `chrome-cdp-ex.action-receipt.v1` as the public receipt schema, but make `settlement` explicit enough for agents to distinguish settled, not-confirmed, not-applicable, and failed actions. Move handoff compacting into a focused receipt-surface helper so full session logs, action JSON, report JSON, and text output can evolve without token drift.

**Tech Stack:** Node.js 22 ESM, Vitest, ESLint, existing `cdp.mjs` action pipeline, existing benchmark gate scripts.

---

### Task 1: Settlement Semantics

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/cdp.test.mjs`
- Modify: `tests/benchmark-killer-path.test.mjs`

- [x] **Step 1: Write failing tests**
  - Add tests proving receipts expose `settlement.state`, `settlement.signals`, `settlement.reason`, and `settlement.timeoutMs`.
  - Cover settled DOM observation, dispatch failure, observation timeout, observation error, and report-only/no-observation actions.

- [x] **Step 2: Verify tests fail**
  - Run `npm test -- tests/cdp.test.mjs -t "settlement semantics|Action Receipt"`.
  - Expected: fail because settlement currently only has `ok`, `strategy`, and `durationMs`.

- [x] **Step 3: Implement minimal settlement helper**
  - Add `buildSettlementReceipt(actionResult)` and route `buildActionReceipt()` through it.
  - Preserve existing `ok`, `strategy`, and `durationMs` fields for compatibility.

- [x] **Step 4: Verify settlement tests pass**
  - Run the focused tests again.

### Task 2: Receipt Surface Contract

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/cdp.test.mjs`

- [x] **Step 1: Write failing tests**
  - Add tests proving action JSON keeps a compact-but-complete receipt.
  - Add tests proving report JSON has a smaller receipt surface than action JSON.
  - Add tests proving session action log retains the full receipt.

- [x] **Step 2: Verify tests fail**
  - Run `npm test -- tests/cdp.test.mjs -t "receipt surface|records action evidence|builds a JSON report model"`.

- [x] **Step 3: Implement receipt surface helpers**
  - Add receipt surface helpers for action JSON and report JSON.
  - Preserve current compacting behavior for unchanged delta channels and recovery duplication.

- [x] **Step 4: Verify surface tests pass**
  - Run the focused tests again.

### Task 3: Docs And Benchmark Gate

**Files:**
- Modify: `docs/reference.md`
- Modify: `docs/examples/killer-path.md`
- Modify: `docs/strategy/agent-browser-vision.md`
- Modify: `TODOS.md`
- Modify: `scripts/benchmark-killer-path.mjs`
- Modify: `tests/benchmark-killer-path.test.mjs`

- [x] **Step 1: Update docs**
  - Document settlement states, signals, reasons, and handoff surfaces.

- [x] **Step 2: Harden benchmark completeness**
  - Require `receipt.settlement.state`, `receipt.settlement.strategy`, `receipt.settlement.durationMs`, and `receipt.settlement.signals`.

- [x] **Step 3: Verify docs and benchmark helper tests**
  - Run `npm test -- tests/benchmark-killer-path.test.mjs tests/cdp.test.mjs`.
  - Run `npm run check:docs`.

### Task 4: Final Verification

**Files:**
- No direct code edits.

- [x] Run `npm test`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:docs`.
- [x] Run `npm run benchmark:killer -- --json`.
- [x] Confirm `gate.passed = true`, total output tokens stay under 20,000, and max step output tokens stay under 5,000.
