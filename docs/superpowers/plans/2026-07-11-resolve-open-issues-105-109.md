# Resolve Open Issues #105-#109 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issues #105-#109 with bounded, test-first changes and prove the complete CLI behavior before review and merge.

**Architecture:** Keep command orchestration in `skills/chrome-cdp-ex/scripts/cdp.mjs`, following the existing single-file CLI layout. Add pure parsers/formatters and dependency-injected probes so each behavior has deterministic unit coverage, then verify browser-dependent behavior through the existing live smoke surface.

**Tech Stack:** Node.js 22+, ESM, Vitest, ESLint, Chrome DevTools Protocol, GitHub Actions, Grok Build CLI.

## Global Constraints

- Preserve existing command behavior unless an issue explicitly requires a safer failure mode.
- Do not add dependencies.
- Keep repeat finite and capped at 50; never auto-remap stale `@ref` handles.
- Keep the daemon dispatcher as the single command execution boundary.
- Do not publish to npm or create a release as part of this work.
- Use red-green TDD for every behavior change.
- Merge only after full local verification, green GitHub CI, and an explicit Grok Build CLI pass.

## File Map

- Modify `skills/chrome-cdp-ex/scripts/cdp.mjs`: command parsers, CDP/TCP probes, scroll settling, console clearing, repeat conditions, flow assertions, help, and test exports.
- Modify `tests/cdp.test.mjs`: deterministic unit and dispatcher-contract coverage for all five issues.
- Modify `tests/current-open-issues.test.mjs`: issue-level acceptance contracts that map directly to #105-#109.
- Modify `scripts/live-smoke.mjs`: owned-page browser checks for smooth scrolling, async eval, console baseline, repeat conditions, and flow assertions.
- Modify `skills/chrome-cdp-ex/SKILL.md`, `docs/reference.md`, and `README.md`: operator-facing syntax and examples.
- Modify `CHANGELOG.md`: unreleased issue-resolution summary if the repository currently maintains an unreleased section.

---

### Task 1: Reject Occupied Debug-Browser Ports (#105)

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Test: `tests/cdp.test.mjs`
- Test: `tests/current-open-issues.test.mjs`

**Interfaces:**
- Produces: `probeTcpPort({ host, port, timeoutMs, connect }) -> Promise<{ occupied: boolean, error?: string }>`
- Consumes: `spawnDebugBrowserStr(args, env, deps)` dependency injection.

- [ ] **Step 1: Write failing tests for responsive and unresponsive listeners**

Add tests that inject `probeTcpPort: async () => ({ occupied: true })` into `spawnDebugBrowserStr`, assert that `spawn` is never called, and expect an error matching `port 9333 is already in use.*choose another port`. Add a free-port test with `{ occupied: false }` that still reaches `waitForSpawnedCdp` and returns the existing readiness output.

- [ ] **Step 2: Verify the tests fail for the missing preflight**

Run: `rtk npm test -- tests/cdp.test.mjs tests/current-open-issues.test.mjs -t "occupied|free port"`

Expected: FAIL because `spawnDebugBrowserStr` launches without consulting the port probe.

- [ ] **Step 3: Implement the TCP preflight**

Add a bounded `net.createConnection({ host, port })` probe that resolves occupied on connection, resolves free on `ECONNREFUSED`, and reports other probe errors. In `spawnDebugBrowserStr`, call the injected/default probe before profile creation or `spawn`; throw:

```js
throw new Error(`spawn-debug-browser: port ${plan.port} is already in use on ${plan.host}. Choose another port with --port <N>.`);
```

- [ ] **Step 4: Verify focused tests pass**

Run: `rtk npm test -- tests/cdp.test.mjs tests/current-open-issues.test.mjs -t "occupied|free port"`

Expected: PASS with no browser process launched for either occupied-port case.

- [ ] **Step 5: Commit the task**

Run: `rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs tests/current-open-issues.test.mjs && rtk git commit -m "fix: reject occupied debug browser ports"`

---

### Task 2: Preserve Multi-Statement Async Eval Results (#106)

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Test: `tests/cdp.test.mjs`
- Test: `tests/current-open-issues.test.mjs`

**Interfaces:**
- Produces: `wrapAwaitExpression(expression, autoWrap) -> string`
- Consumes: `evalStr` and `evalFireAndForgetStr`.

- [ ] **Step 1: Write failing transformation and evaluation tests**

Cover `await Promise.resolve(42)`, `const value = await Promise.resolve(42); value`, explicit `return value`, newline-separated final expressions, ambiguous trailing control statements, eval64 transport, and fire-and-forget. Assert the inferred case sends `(async()=>{const value = await Promise.resolve(42); return (value);})()` and that ambiguous input throws actionable `add an explicit return` guidance.

- [ ] **Step 2: Verify inferred-result tests fail**

Run: `rtk npm test -- tests/cdp.test.mjs tests/current-open-issues.test.mjs -t "multi-statement async|explicit return|ambiguous async"`

Expected: FAIL because the current block wrapper omits the final return.

- [ ] **Step 3: Implement one shared await wrapper**

Replace duplicate wrapping logic in `evalStr` and `maybeAutoWrapEval` with `wrapAwaitExpression`. Preserve expression-body wrapping for single expressions and explicit-return block bodies. For block input without `return`, split only a syntactically simple trailing expression statement and emit `return (<expression>)`; otherwise throw before CDP dispatch.

- [ ] **Step 4: Verify focused tests pass**

Run: `rtk npm test -- tests/cdp.test.mjs tests/current-open-issues.test.mjs -t "await|eval64|fire-and-forget"`

Expected: PASS; the issue example returns `42` and existing eval modes remain unchanged.

- [ ] **Step 5: Commit the task**

Run: `rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs tests/current-open-issues.test.mjs && rtk git commit -m "fix: return async eval final expressions"`

---

### Task 3: Settle Smooth Scrolling Before Pointer Dispatch (#107)

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Test: `tests/cdp.test.mjs`
- Test: `scripts/live-smoke.mjs`

**Interfaces:**
- Produces: `scrollElementIntoViewAndMeasure` page function semantics returning the final `{ x, y, w, h, tag, text }`.
- Consumes: `resolveRef` and CSS-selector coordinate resolution in `clickStr`.

- [ ] **Step 1: Write failing CDP contract tests**

Assert `resolveRef` and selector click evaluation use an async function that calls `scrollIntoView`, samples `getBoundingClientRect()` across animation frames until two consecutive positions are stable, and returns the final sample. Add a timeout/bounded-sample assertion and an already-visible minimum-sample assertion.

- [ ] **Step 2: Verify tests fail on immediate measurement**

Run: `rtk npm test -- tests/cdp.test.mjs -t "smooth scroll|scroll settling|final coordinates"`

Expected: FAIL because current code measures in the same frame as `scrollIntoView`.

- [ ] **Step 3: Implement bounded scroll settling**

Use a page-side async helper with at most 12 animation-frame samples and a sub-pixel stability threshold. Re-read the element rectangle after stability and return only that final rectangle. Reuse the same generated function body for refs and selectors rather than adding fixed sleeps.

- [ ] **Step 4: Verify unit tests pass**

Run: `rtk npm test -- tests/cdp.test.mjs -t "smooth scroll|scroll settling|final coordinates"`

Expected: PASS.

- [ ] **Step 5: Extend the owned live fixture**

Add a smooth-scrolling below-fold button to `scripts/live-smoke.mjs`; verify one `click @ref` changes observable state at desktop and mobile viewport sizes, while an already-visible button remains one-click successful.

- [ ] **Step 6: Commit the task**

Run: `rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs scripts/live-smoke.mjs && rtk git commit -m "fix: settle scroll before pointer clicks"`

---

### Task 4: Add Strict Console Baselines (#108)

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Test: `tests/cdp.test.mjs`
- Test: `tests/current-open-issues.test.mjs`

**Interfaces:**
- Produces: `parseConsoleArgs(args) -> { mode: 'unread'|'all'|'errors'|'clear', format: 'text'|'json' }`
- Produces: `clearConsoleBaseline(consoleBuf, exceptionBuf, lastReadSeq) -> { schema, cleared }`
- Consumes: daemon `console` dispatch.

- [ ] **Step 1: Write failing parser, buffer, and health tests**

Cover supported modes, unknown flags, conflicting modes, text/JSON clear acknowledgement, cleared console and exception buffers, advanced cursors, empty summary/perceive health after clear, and collection of new post-clear entries.

- [ ] **Step 2: Verify tests fail on silent unknown flags and missing clear**

Run: `rtk npm test -- tests/cdp.test.mjs tests/current-open-issues.test.mjs -t "console baseline|console --clear|unknown console"`

Expected: FAIL because `--clear` and unknown flags currently fall through to unread mode.

- [ ] **Step 3: Implement strict console modes and baseline clearing**

Parse all arguments before touching buffers. Clear both buffers, set both cursors to their current sequence values, and return `Console baseline cleared (console and exception buffers)` or a versioned JSON model. Make `consoleStr` and `buildConsoleModel` consume the parsed mode rather than raw flags.

- [ ] **Step 4: Verify focused tests pass**

Run: `rtk npm test -- tests/cdp.test.mjs tests/current-open-issues.test.mjs -t "console"`

Expected: PASS with unknown options rejected before cursor advancement.

- [ ] **Step 5: Commit the task**

Run: `rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs tests/current-open-issues.test.mjs && rtk git commit -m "feat: add console baseline clearing"`

---

### Task 5: Add Bounded Repeat Conditions And Flow Assertions (#109)

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Test: `tests/cdp.test.mjs`
- Test: `tests/current-open-issues.test.mjs`

**Interfaces:**
- Produces: `parsePageConditionArgs(args) -> { condition, remainingArgs }`
- Produces: `probePageCondition(cdp, sid, condition) -> Promise<{ matched, description }>`
- Extends: `repeatStr({ run, probeCondition }, args)`
- Extends: `flowStr({ run, settle, assertCondition }, input, options)`

- [ ] **Step 1: Write failing repeat parser and execution tests**

Cover selector existence, selector absence, visible text, mutually exclusive flags, missing values, early success, DOM replacement through a fresh probe per iteration, cap exhaustion throwing with transcript, fail-fast inner error, and `--continue` behavior.

- [ ] **Step 2: Verify repeat condition tests fail**

Run: `rtk npm test -- tests/cdp.test.mjs tests/current-open-issues.test.mjs -t "until-selector|until-text|cap exhaustion"`

Expected: FAIL because condition flags are currently forwarded to the inner command.

- [ ] **Step 3: Implement condition parsing, probing, and repeat transcript**

Remove exactly one condition flag/value pair before inner-command parsing. Probe after each successful iteration. On match, append `Condition satisfied after iteration N/M` and return. If the cap is reached, throw `repeat: condition not satisfied after N iterations` plus the complete transcript. Preserve unconditional repeat output byte-for-byte where practical.

- [ ] **Step 4: Write failing flow assertion tests**

Cover `assert selector .done`, `assert selector-missing .loading`, `assert text "Battle complete"`, failure halting, skipped downstream steps, and JSON failed-step metadata.

- [ ] **Step 5: Implement assertion parsing and shared probing**

Extend `parseFlowSteps` with `kind: 'assert'` and `{ condition }`. Route assertion execution through the same condition probe as repeat. Failed assertions use the existing flow failure model and skip later steps.

- [ ] **Step 6: Verify focused #109 tests pass**

Run: `rtk npm test -- tests/cdp.test.mjs tests/current-open-issues.test.mjs -t "repeat|flow|condition|assert"`

Expected: PASS with bounded failure and no stale-ref remapping.

- [ ] **Step 7: Commit the task**

Run: `rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs tests/current-open-issues.test.mjs && rtk git commit -m "feat: add bounded state aware flows"`

---

### Task 6: Documentation And Live Acceptance

**Files:**
- Modify: `skills/chrome-cdp-ex/SKILL.md`
- Modify: `docs/reference.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `scripts/live-smoke.mjs`

**Interfaces:**
- Consumes: final CLI syntax from Tasks 1-5.
- Produces: operator examples and live acceptance evidence.

- [ ] **Step 1: Add issue examples and safety wording**

Document console baselining, the async eval final-expression example, occupied-port failure, one-click smooth-scroll behavior, selector/text repeat conditions, selector absence, flow assertions, cap exhaustion, and stable-selector guidance for long loops.

- [ ] **Step 2: Extend live smoke assertions**

On the owned fixture, run the issue #106 example and assert `42`; emit pre-baseline console/exception entries, clear, and assert healthy summary before emitting a new captured error; exercise repeat early success/cap failure and flow assertion pass/fail; run desktop/mobile smooth-scroll clicks.

- [ ] **Step 3: Run live smoke**

Run: `rtk npm run smoke:live`

Expected: exit 0 with explicit checks for all four live-browser-relevant issues (#106-#109). #105 remains covered deterministically because intentionally occupying arbitrary user ports in live smoke is unnecessary and risky.

- [ ] **Step 4: Run docs contract and commit**

Run: `rtk npm run check:docs`

Expected: PASS.

Run: `rtk git add skills/chrome-cdp-ex/SKILL.md docs/reference.md README.md CHANGELOG.md scripts/live-smoke.mjs && rtk git commit -m "docs: document issue resolution workflows"`

---

### Task 7: Full Verification, PR, Grok Review, And Merge

**Files:**
- Verify all modified files.

**Interfaces:**
- Consumes: all task commits and issue acceptance criteria.
- Produces: merged PR, closed issues, and synchronized clean `main`.

- [ ] **Step 1: Run the complete local gate**

Run:

```bash
rtk npm test
rtk npm run lint
rtk npm run check:docs
rtk npm pack --dry-run
rtk git diff --check origin/main...HEAD
```

Expected: every command exits 0; package contents contain intended runtime/docs files and no private artifacts.

- [ ] **Step 2: Audit issue coverage and repository privacy**

Map each acceptance bullet in #105-#109 to a named test/live check. Inspect `rtk git diff origin/main...HEAD` and run a focused secret/path scan; remove unrelated churn or sensitive data before publication.

- [ ] **Step 3: Push and open a ready PR to `origin/main`**

Push `feature/resolve-open-issues-105-109`, then open a PR whose body includes `Fixes #105` through `Fixes #109`, root causes, validation commands, and live evidence.

- [ ] **Step 4: Wait for GitHub CI**

Run: `rtk gh pr checks --watch`

Expected: every required check passes.

- [ ] **Step 5: Run Grok Build CLI review**

Run Grok in single-turn, no-edit mode against `origin/main...HEAD`, requiring structured output with `verdict` (`pass` or `fail`) and blocking findings. The prompt must focus on correctness, safety, regression risk, acceptance coverage, and false-green tests. A `fail` verdict blocks merge.

- [ ] **Step 6: Address valid Grok findings test-first**

For each technically valid finding, write and observe a failing regression test, implement the minimum fix, rerun the focused and complete gates, push, wait for CI, and rerun Grok. Reject invalid findings with code/test evidence. Repeat until Grok returns explicit `pass` with zero blocking findings.

- [ ] **Step 7: Merge and verify closure**

Merge the PR to `origin/main` with branch deletion. Fetch/switch/pull `main`; verify `main...origin/main` divergence is `0 0`, `git status -sb` is clean, issues #105-#109 are closed, the PR is merged, and the merge commit is present on `origin/main`.
