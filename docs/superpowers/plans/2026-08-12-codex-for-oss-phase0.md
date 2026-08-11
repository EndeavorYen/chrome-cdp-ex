# Codex for OSS Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce fresh v2.14.0 release proof, a deterministic Codex host-validation contract, safe demo assets, and a dated Codex for OSS evidence baseline without publishing externally.

**Architecture:** Keep the existing benchmark runtime unchanged and layer a small validation contract around repository evidence. Use JSON as the machine-readable host matrix, Markdown for operator/application narratives, the existing benchmark updater for measured README/HTML claims, and generated MP4/PNG assets for the demo.

**Tech Stack:** Node.js 22 ESM, Vitest, existing CDP benchmark runners, GitHub CLI/API, FFmpeg, Markdown, JSON.

## Global Constraints

- Work only on `feature/codex-for-oss-phase0` in the isolated worktree.
- Use disposable local debug-browser fixtures; do not inspect or record personal browser state.
- Do not add runtime dependencies.
- Do not publish a release, submit an application, open external pull requests, or post to communities.
- Do not claim every host is live-validated; Phase 0 live-validates only Codex.
- Update benchmark claims only after a passing ten-round mixed campaign.
- Preserve GitHub Releases and attached tarballs as the official publish surface; do not publish to npm.
- Do not stage, commit, push, or create a pull request without separate explicit authorization.

---

### Task 1: Host Validation Contract

**Files:**
- Create: `scripts/check-host-validation.mjs`
- Create: `tests/host-validation.test.mjs`
- Create: `docs/benchmarks/host-validation.v1.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `SUPPORTED_HOSTS` from `scripts/setup.mjs`, repository-relative evidence paths, and `package.json.version`.
- Produces: `validateHostValidation(manifest, { packageVersion, supportedHosts, rootDir }) -> string[]` and `npm run check:host-validation`.

- [ ] **Step 1: Write failing validation tests**

Add Vitest cases proving that the checked-in manifest passes and that version drift, unknown statuses, duplicate/missing hosts, invalid dates, missing evidence paths, and incomplete live capability evidence each return a precise error.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm test -- tests/host-validation.test.mjs`

Expected: FAIL because `scripts/check-host-validation.mjs` and the manifest do not exist.

- [ ] **Step 3: Implement the minimal checker and manifest**

The manifest uses this shape:

```json
{
  "schema": "chrome-cdp-ex.host-validation.v1",
  "productVersion": "2.14.0",
  "validatedAt": "2026-08-12",
  "environment": {
    "host": "Codex",
    "route": "cli-skill",
    "browserScope": "disposable-local-fixture"
  },
  "hosts": [
    {
      "name": "codex",
      "status": "live-validated",
      "route": "cli",
      "capabilities": {
        "install": true,
        "doctor": true,
        "perceive": true,
        "act": true,
        "actionReceipt": true,
        "sinceAction": true,
        "report": true
      },
      "evidence": ["docs/examples/codex-killer-path.md"]
    }
  ]
}
```

Add the other five supported hosts with `documented` or `setup-smoke` status and evidence links to their integration docs. The CLI entrypoint exits non-zero and prints one error per line when validation fails.

- [ ] **Step 4: Add the package script and rerun focused tests**

Add `"check:host-validation": "node scripts/check-host-validation.mjs"` to `package.json`.

Run:

```bash
npm test -- tests/host-validation.test.mjs
npm run check:host-validation
```

Expected: PASS with zero validation errors.

### Task 2: Codex Killer Path and Integration Matrix

**Files:**
- Create: `docs/examples/codex-killer-path.md`
- Modify: `INTEGRATIONS.md`
- Modify: `docs/integrations/codex.md`
- Modify: `README.md`
- Modify: `tests/docs-contract.test.mjs`

**Interfaces:**
- Consumes: the validated manifest from Task 1 and existing `chrome-cdp-ex.action-receipt.v1`, doctor, perception, and report output contracts.
- Produces: a reproducible Codex validation narrative and human host matrix linked from primary entrypoints.

- [ ] **Step 1: Add the missing evidence file and observe the manifest failure**

Add `docs/examples/codex-killer-path.md` to the manifest evidence list before creating the file.

- [ ] **Step 2: Run the host checker and confirm failure**

Run: `npm run check:host-validation`

Expected: FAIL because the manifest points to an evidence path that does not yet exist.

- [ ] **Step 3: Write the Codex evidence guide and matrix**

Document exact install/setup/verify commands, the full perception-to-report sequence, expected schemas, environment metadata, and claim limits. In `INTEGRATIONS.md`, add columns for route, current evidence status, last validation date, and evidence link. Keep non-Codex hosts at their manifest status.

- [ ] **Step 4: Link the validated path from README and rerun docs gates**

Run:

```bash
npm test -- tests/docs-contract.test.mjs tests/host-validation.test.mjs
npm run check:docs
npm run check:host-validation
```

Expected: PASS.

### Task 3: Fresh v2.14.0 Live Proof

**Files:**
- Modify: `README.md`
- Modify: `experiment/benchmark.html`
- Modify: `experiment/benchmark-proof.png`
- Local-only artifact: `/tmp/chrome-cdp-ex-phase0/release-campaign-v2.14.0-postfix.json`

**Interfaces:**
- Consumes: `npm run benchmark:campaign` and `npm run benchmark:update-readme`.
- Produces: a gated current-release snapshot in README/HTML/PNG and a local raw campaign record.

- [ ] **Step 1: Run setup verification**

Run: `node scripts/setup.mjs --for codex` and `node scripts/setup.mjs --verify`.

Expected: Codex route is printed, MCP initialize succeeds, and doctor returns a structured result. Browser readiness may be advisory before the disposable campaign starts.

- [ ] **Step 2: Run the ten-round mixed campaign serially**

Run:

```bash
mkdir -p /tmp/chrome-cdp-ex-phase0
npm run benchmark:campaign -- --rounds 10 --types mcp,cli,killer,large-app,real-app,real-app,real-app,real-app,real-app,cli --real-app-targets dashboard,docs-app,auth-flow,data-table,canvas-heavy --settle-ms 0 --json --output /tmp/chrome-cdp-ex-phase0/release-campaign-v2.14.0-postfix.json
```

Expected: schema `chrome-cdp-ex.live-campaign.v1`, 10 completed rounds, 10 passing rounds, and no failed gate criteria.

- [ ] **Step 3: Update README and benchmark page only from the passing artifact**

Run:

```bash
npm run benchmark:update-readme -- /tmp/chrome-cdp-ex-phase0/release-campaign-v2.14.0-postfix.json README.md --html experiment/benchmark.html --date 2026-08-12
```

Regenerate `experiment/benchmark-proof.png` from the updated safe local benchmark page using the repository's browser tooling or a deterministic screenshot command.

- [ ] **Step 4: Check that stale latest-proof claims are gone**

Search README and benchmark HTML. Historical v2.12.0 references may remain only when clearly labeled historical; all “latest” or “release proof” labels must identify v2.14.0 and 2026-08-12.

### Task 4: Safe 60-Second Demo Assets

**Files:**
- Create: `experiment/codex-killer-path-demo.mp4`
- Create: `experiment/codex-killer-path-demo-poster.png`
- Create: `experiment/codex-killer-path-demo.html`
- Modify: `README.md`

**Interfaces:**
- Consumes: safe fixture screenshots and structured evidence from Task 3.
- Produces: a 60-second 1280x720 MP4, a readable poster image, and an HTML source/storyboard that can be regenerated without private data.

- [ ] **Step 1: Build the storyboard source**

Create seven timed scenes: problem, Codex installation route, perception, action, Action Receipt, `perceive --since-action`, and report/claim boundary. Use only repository screenshots, safe local fixture output, and measured v2.14.0 facts.

- [ ] **Step 2: Render poster and MP4**

Render the HTML at 1280x720 and encode a 60-second H.264 MP4 with `yuv420p` pixel format. The poster must show the product name, Codex route, and `v2.14.0 live-validated` without implying all hosts passed.

- [ ] **Step 3: Verify media metadata and content boundary**

Run `ffprobe` to confirm 1280x720 dimensions, approximately 60 seconds duration, H.264 video, and no unexpected audio or metadata. Inspect the poster and representative video frames visually.

- [ ] **Step 4: Link the demo from README**

Add a compact `Validated with Codex` proof row linking the poster, MP4, Codex Killer Path, and host manifest.

### Task 5: Codex for OSS Evidence Baseline

**Files:**
- Create: `docs/outreach/codex-for-oss-evidence.md`
- Modify: `docs/outreach/awesome-lists.md`
- Modify: `tests/docs-contract.test.mjs`

**Interfaces:**
- Consumes: GitHub API measurements captured on 2026-08-12 and the current curated-list entry.
- Produces: a dated application-evidence record with measured facts, provenance links, claim-safe phrasing, gaps, and next refresh commands.

- [ ] **Step 1: Capture the measurements independently**

Rerun the exact GitHub API queries for repository metadata, traffic, releases, issues, pull requests, stargazers, and code references. Save only the hand-checked aggregate values in working notes; do not derive expected documentation values from a script under test.

- [ ] **Step 2: Write the evidence page**

Record 12 stars, 0 forks, 17 releases, 18 cumulative release-asset downloads, 6 v2.14.0 asset downloads, 59 issues, 53 pull requests, one external merged PR, 40 unique visitors, 49 unique cloners, and 22 GitHub code-search references with the note that most are mirrors or indexes. Link the OpenAI form, repository, external PR, and curated list. Add exact `gh api` refresh commands without storing credentials or raw private traffic payloads.

- [ ] **Step 3: Update outreach routing**

Mark Phase 0 as the prerequisite for later Awesome Claude Code description refresh, Awesome Codex Skills, Awesome MCP Servers, and Awesome Browser Automation submissions. Keep the existing prohibition on automatic external submissions.

- [ ] **Step 4: Rerun documentation verification and inspect claims**

Run: `npm test -- tests/docs-contract.test.mjs && npm run check:docs`.

Expected: PASS. Manually compare every numerical statement with the captured API aggregates and verify that mirrors/indexes are not described as downstream users.

### Task 6: Final Acceptance Gate

**Files:**
- Review all Phase 0 changes.

**Interfaces:**
- Consumes: all previous deliverables.
- Produces: a clean verification report and an uncommitted feature branch ready for user review.

- [ ] **Step 1: Run focused and full deterministic gates**

Run:

```bash
npm test
npm run lint
npm run check:docs
npm run check:host-validation
npm pack --dry-run
npm audit --json
```

Expected: tests, lint, docs, host validation, and package dry-run pass. Audit findings are reported accurately and classified as runtime or development-only.

- [ ] **Step 2: Inspect the full diff and generated assets**

Confirm there are no secrets, personal paths in published docs, raw browser cookies, unrelated lockfile changes, unsupported adoption claims, or external-publication actions.

- [ ] **Step 3: Report outcomes without publishing**

Provide the branch, worktree, changed files, benchmark outcome, media metadata, current evidence snapshot, audit classification, and any remaining blocker. Do not stage, commit, push, open a PR, or post externally.
