# Action Receipt Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a first-class Action Receipt contract for `chrome-cdp-ex` and document the broader agent observability roadmap it unlocks.

**Architecture:** Keep the existing `chrome-cdp-ex.action.v1` envelope for backward compatibility, and add a derived `receipt` object with schema `chrome-cdp-ex.action-receipt.v1`. The receipt normalizes dispatch, settlement, observed deltas, blocking signals, and recovery hints from the existing outcome/diagnosis/recommendation pipeline. Benchmark and docs gates treat the receipt as the stable agent handoff contract.

**Tech Stack:** Node.js 22 ESM, Vitest, existing single-file `cdp.mjs` command runtime, existing docs contract/benchmark scripts.

---

### Task 1: Action Receipt Contract

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Test: `tests/cdp.test.mjs`

- [x] Write failing tests proving `createActionResult()` attaches `receipt.schema`, `actionId`, `dispatch`, `settlement`, `observedDelta`, `blockingSignals`, `recoveryHint`, and `nextSteps`.
- [x] Implement the minimal receipt builder from existing action evidence fields.
- [x] Export receipt helpers through `__test__`.
- [x] Verify focused tests pass with `npm test -- tests/cdp.test.mjs -t "Action Receipt"`.
- [x] Add structured `observedDeltaDetails` and session `eventId` / `sequence` fields without changing the v1 schema name.

### Task 2: No-Change Blocking Signals

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs`
- Test: `tests/cdp.test.mjs`
- Test: `tests/action-recovery-lib.test.mjs`

- [x] Write failing tests proving no-change receipts expose target-aware `overlay-check-needed`, `frame-check-needed`, and `fresh-perception-needed` blocking signals plus a recovery hint.
- [x] Extend no-change recommendations with structured signal names and conditional frame recovery.
- [x] Verify no-change action text and JSON make retry avoidance explicit.

### Task 3: Benchmark Gate

**Files:**
- Modify: `scripts/benchmark-killer-path.mjs`
- Modify: `tests/benchmark-killer-path.test.mjs`

- [x] Write failing tests proving action JSON without `receipt` fails the benchmark gate.
- [x] Add receipt coverage metrics and gate criteria.
- [x] Update benchmark fixture expectations so the gate names the receipt requirement.

### Task 4: Docs And Roadmap

**Files:**
- Modify: `README.md`
- Modify: `docs/reference.md`
- Modify: `docs/strategy/agent-browser-vision.md`
- Modify: `docs/examples/killer-path.md`
- Modify: `TODOS.md`

- [x] Document Action Receipt as a first-class contract.
- [x] Document the agent observability contracts: perception, action receipt, recovery, session handoff, benchmark.
- [x] Move broader items into a concrete roadmap: adaptive perception budget, recovery policy registry, component inspection, multi-tab coordination, and Browser Use mapping.
- [x] Verify docs contracts with `npm run check:docs`.

### Task 5: Verification

**Files:**
- No direct code edits.

- [x] Run focused tests: `npm test -- tests/cdp.test.mjs tests/action-recovery-lib.test.mjs tests/benchmark-killer-path.test.mjs`.
- [x] Run full unit suite: `npm test`.
- [x] Run lint: `npm run lint`.
- [x] Run docs contract: `npm run check:docs`.
- [x] Run live benchmark: `npm run benchmark:killer -- --json` passes 29/29 gate with 19,177 estimated output tokens and 4,553 max-step tokens.
