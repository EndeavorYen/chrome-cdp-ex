# Resolve Open Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the remaining open chrome-cdp-ex issues, verify the Smart Eye workflow is trustworthy for other projects, and leave `main` plus branches clean.

**Architecture:** Keep the CLI entrypoint at `skills/chrome-cdp-ex/scripts/cdp.mjs`, but move pure action recovery, perception model, and session report recommendation helpers into focused `lib/` modules. Use contract tests and benchmark helper tests to protect issue acceptance without requiring a live browser for every gate.

**Tech Stack:** Node 22 ESM, Vitest, ESLint, GitHub Issues/PRs, existing benchmark and docs-contract scripts.

---

### Task 1: Release and CI Trust Gates

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/check-docs-contract.mjs`
- Test: `tests/docs-contract.test.mjs`

- [ ] **Step 1: Add failing tests for main PR CI and release trust wording**

Add tests that fail when CI does not run for `main` pull requests and when release docs omit the first-run checklist.

- [ ] **Step 2: Update workflow and docs contract**

Change the CI trigger to include both `main` and `dev`. Keep the docs contract checking package/plugin version alignment, README benchmark proof, and Killer Path order.

- [ ] **Step 3: Verify**

Run `npm run check:docs` and `npm test tests/docs-contract.test.mjs`.

### Task 2: Module Boundaries for cdp.mjs

**Files:**
- Create: `skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs`
- Create: `skills/chrome-cdp-ex/scripts/lib/perception-model.mjs`
- Create: `skills/chrome-cdp-ex/scripts/lib/session-report.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Test: `tests/action-recovery-lib.test.mjs`
- Test: `tests/perception-model-lib.test.mjs`
- Test: `tests/session-report-lib.test.mjs`

- [ ] **Step 1: Write direct module tests**

Cover stale refs, overlays, wrong frames, console errors, network failures, no-change recommendations, perception JSON shape, and report next-step selection.

- [ ] **Step 2: Extract pure helpers**

Move the pure helper logic from `cdp.mjs` into the new modules while preserving `__test__` exports for existing tests.

- [ ] **Step 3: Verify behavior compatibility**

Run `npm test tests/cdp.test.mjs tests/action-recovery-lib.test.mjs tests/perception-model-lib.test.mjs tests/session-report-lib.test.mjs`.

### Task 3: Smart Eye Diagnostic Chooser

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Test: `tests/action-recovery-lib.test.mjs`
- Test: `tests/cdp.test.mjs`

- [ ] **Step 1: Test diagnostic recommendations**

Assert that stale-ref, overlay, wrong-frame, console-error, network-failure, and no-change cases expose a primary command plus ordered `nextSteps` in JSON and text-friendly models.

- [ ] **Step 2: Fill gaps**

If any diagnosis lacks structured commands, add the smallest recovery policy needed by the failing test.

- [ ] **Step 3: Verify**

Run the targeted tests and confirm existing action evidence tests still pass.

### Task 4: Workflow Compiler Acceptance Path

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Test: `tests/cdp.test.mjs`
- Docs: `docs/examples/killer-path.md`

- [ ] **Step 1: Test record/replay/export handoff**

Ensure `record-actions -> replay -> export-playwright` exposes exported, skipped, review-needed, and assertion counts.

- [ ] **Step 2: Patch missing handoff details**

Keep portable selectors exported, session-local refs skipped with review notes, and observed text converted into Playwright assertions.

- [ ] **Step 3: Verify**

Run `npm test tests/cdp.test.mjs tests/docs-contract.test.mjs`.

### Task 5: Modern Web App Coverage and Baselines

**Files:**
- Modify: `scripts/benchmark-killer-path.mjs`
- Modify: `tests/benchmark-killer-path.test.mjs`
- Modify: `scripts/benchmark-playwright-baseline.mjs`
- Modify: `scripts/benchmark-generic-cdp-baseline.mjs`
- Test: related benchmark tests

- [ ] **Step 1: Test fixture coverage gates**

Assert benchmark summary requires iframe, modal/overlay, HMR/SPA diff, guarded-page/auth state, and recovery-command coverage.

- [ ] **Step 2: Extend benchmark plan/summary**

Add guarded-page and recovery-command probes to the benchmark helper model, keeping live requirements local and deterministic.

- [ ] **Step 3: Verify**

Run benchmark helper tests and docs contract.

### Task 6: Final Verification and GitHub Cleanup

**Files:**
- All touched files

- [ ] **Step 1: Full local verification**

Run `npm run check:docs`, `npm run lint`, `npm test`, and `git diff --check`.

- [ ] **Step 2: Publish and merge**

Push `feature/resolve-open-issues`, open a PR to `main`, merge after checks or local proof, then delete feature branches.

- [ ] **Step 3: Issues and branch cleanup**

Close completed issues #12-#17, close epic #3 only after the checklist is genuinely satisfied, keep or remove remote `dev` based on whether its release automation is obsolete.
