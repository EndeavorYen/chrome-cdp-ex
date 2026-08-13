# Truthful Bounded Table Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `table` truthful and bounded on static and genuinely virtualized tables, with a private artifact/continuation path that CLI and MCP agents can use without losing rows or flooding context.

**Architecture:** Keep the existing 81-command CLI and extend `table` instead of adding a second extraction command. Put canonical row encoding, completeness, budgeting, manifests, and continuation validation in a small pure module; keep DOM sampling and scrolling in the daemon; store full exports only beneath a session-owned private runtime directory. Default observation becomes a bounded preview with explicit provenance, while confirmed `--collect` is the only mode allowed to scroll or click.

**Tech Stack:** Node.js 22 ESM, raw Chrome DevTools Protocol, Vitest, the catalog-owned CLI/MCP surface, JSON Schema, and the repository's generated contract/docs tooling.

## Global Constraints

- Preserve exactly 81 CLI commands; extend `table` rather than adding another CLI command.
- Use strict RED -> GREEN TDD. Commit test-only RED checkpoints separately from production GREEN checkpoints when the RED is meaningful and reviewable.
- Keep commits small and periodic; generated fixtures and version/contract refreshes are separate mechanical commits.
- Do not modify `docs/contracts/v2.15.0/*`; published contract fixtures are immutable.
- Treat the behavior as unreleased v2.16.0. Do not create a GitHub Release or publish to npm in this plan.
- Default inline preview is at most 20 data rows and 8,192 UTF-8 bytes; the complete JSON response is at most 16,384 UTF-8 bytes.
- Collection limits are fixed ceilings: 100,000 unique rows, 16 MiB artifact bytes, 256 interactions, five minutes, and three consecutive no-progress cycles. Callers may lower but never raise them.
- `logicalRows` comes only from explicit semantic evidence such as `aria-rowcount`; never infer it from captions, prose, or `data-source-rows`.
- `complete` requires known logical count, exact collected-count equality, and safe termination. A disappeared load-more control alone never proves completeness.
- Virtual collection requires exactly one table, an explicit `--scroll-container`, and stable identity from `aria-rowindex` or zero-based `--row-key-column N`. Duplicate/conflicting keys fail closed; never deduplicate by row text.
- `--collect` is the only mutating mode and requires confirmation. Observation and `--continue` are reads. Never automatically replay an interaction after daemon/transport ambiguity.
- Artifacts are runtime-owned only: no caller-chosen paths; directories mode 0700; files mode 0600; atomic no-clobber writes; opaque bounded token; exact target/session/artifact binding; cleanup with the owning session.
- Full artifact checksum is SHA-256 over exact UTF-8 canonical `rows.tsv` bytes. Issue #151's 1,024-row fixture must produce `73e9f36080b8c781e204857ad9c7dcf4ce7ce419b1503d9affd0343f58f964ed`.
- MCP and CLI must use the same runtime engine. Compare parsed semantics and artifact hashes while ignoring only the CLI terminal newline and explicitly enumerated volatile IDs/paths/timestamps.
- No personal browser profile, login, external mutation, or npm publication. Live validation uses fresh task-local Chrome-for-Testing, loopback fixtures, private runtime roots, and proves cleanup.
- Scope is Critical/Important agent harm only. Do not fold in heuristic container discovery, multi-table collection, caller output paths, arbitrary dynamic MCP resources, or unrelated cleanup.

---

### Task 1: Pure table truth, canonicalization, and budgeting

**Files:**
- Create: `skills/chrome-cdp-ex/scripts/lib/table-extraction.mjs`
- Create: `tests/table-extraction.test.mjs`

**Interfaces:**
- Produces: immutable `TABLE_EXTRACTION_LIMITS` with the fixed ceilings above.
- Produces: `canonicalizeTableCells(cells) -> string`, where backslash, tab, CR, and LF are escaped deterministically before tab-joining cells.
- Produces: `createTableAccumulator({ logicalRows, logicalCountSource, identitySource, orderingSource })` and `addTableSample(accumulator, sample)` for unique-key retention, row-conflict detection, mounted-node recycling evidence, and canonical byte accounting.
- Produces: `finalizeTableExtraction(accumulator, { termination, limits }) -> chrome-cdp-ex.table.v1` and `buildTableExportManifest(...) -> chrome-cdp-ex.table-export.v1`.
- Produces: `buildInlineTablePreview(rows, limits)` that truncates only at complete UTF-8 row boundaries and reports exact row/byte counts.
- Later tasks consume these functions; this task has no filesystem or CDP effects.

- [ ] **Step 1: Write independent failing tests for truthful mounted observation**

  Add literal fixtures proving 12 mounted rows with `aria-rowcount=1024` report `logicalRows:1024`, `mountedRows:12`, `collectedRows:12`, and `completeness.state:"incomplete"`; missing logical evidence reports `logicalRows:null` and `state:"unknown"`.

- [ ] **Step 2: Run the new test file and verify RED**

  Run `npm test -- tests/table-extraction.test.mjs`. Expected: module/export-not-found failures only.

- [ ] **Step 3: Implement the minimal pure observation model and make those tests GREEN**

  Validate all inputs as own plain data; reject accessors, custom prototypes, symbols, sparse arrays, non-string cells, non-finite/negative counts, and unknown provenance enums before deriving output.

- [ ] **Step 4: Add RED tests for canonical bytes and bounds**

  Use hand-derived strings for escaping, multibyte rows, exactly-8,192-byte boundaries, 20-row preview, 16,384-byte response pressure, and the fixed 1,024-row checksum. Tests must assert complete-row truncation and no replacement-character corruption.

- [ ] **Step 5: Implement canonicalization, preview, checksum, and manifest GREEN**

  Hash exact `Buffer.from(rowsTsv, "utf8")`; `inline.bytes` is the included preview byte count and `artifact.bytes` is the full canonical body byte count.

- [ ] **Step 6: Add RED tests for recycling, conflicts, and stop reasons**

  Freeze cases for the same mounted node carrying different keys, duplicate keys with identical bytes, duplicate keys with conflicting bytes, unknown totals, logical-count reached, row/byte/interaction/time/no-progress limits, and partial-artifact truth.

- [ ] **Step 7: Implement accumulator semantics and run focused GREEN**

  Run `npm test -- tests/table-extraction.test.mjs`; then run lint on both new files.

- [ ] **Step 8: Commit Task 1 in small checkpoints**

  Commit the verified RED first, then the pure GREEN implementation. Do not touch runtime/catalog/docs in these commits.

---

### Task 2: Bounded runtime observation, private artifacts, and continuation

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/lib/daemon-read-handlers.mjs`
- Modify: `tests/cdp.test.mjs`
- Modify: `tests/daemon-read-handlers.test.mjs`
- Modify: `tests/command-application.test.mjs`
- Modify: `tests/current-open-issues.test.mjs`

**Interfaces:**
- Consumes Task 1's pure functions and limits.
- Produces: `parseTableArgs(args)` for `[selector]`, `--collect`, `--row-key-column N`, `--scroll-container SELECTOR`, `--load-more SELECTOR`, `--continue TOKEN`, and `--format text|json` with exact duplicate/ambiguous/unknown-argument rejection.
- Produces: `tableStr(cdp, sessionId, session, args)` returning bounded text or `chrome-cdp-ex.table.v1` JSON.
- Produces: session-owned `tableArtifactDir`, manifest/data lifecycle, opaque continuation token, and report/cleanup accounting.
- Changes `createDaemonReadHandlers` so the table capability receives the complete ordered argv array, including duplicates and empty strings for parser-owned errors.

- [ ] **Step 1: Write RED parser and daemon-routing tests**

  Prove full argv order reaches the production table capability; `--continue` excludes selector/collection flags; `--collect` requires selector plus explicit scroll container and stable identity; numeric bounds cannot exceed fixed ceilings; accessors/custom prototypes/symbols/sparse argv are rejected before capability effects.

- [ ] **Step 2: Verify parser/routing RED, then implement minimal GREEN**

  Run `npm test -- tests/daemon-read-handlers.test.mjs tests/command-application.test.mjs tests/cdp.test.mjs` with the exact new test filters.

- [ ] **Step 3: Write RED production-facing observation tests**

  Feed real Runtime.evaluate result shapes for: no table; one static table; one 12-of-1024 virtual table; multiple tables; captions that falsely claim 1,024 rows; large 1,024-row materialized output; UTF-8 cells; and malformed/oversized page output. Assert default text and JSON are bounded and never claim a mounted subset is full.

- [ ] **Step 4: Replace mounted-only `tableStr` with bounded observation GREEN**

  The in-page script returns bounded structured samples, not a pre-rendered unbounded table string. Node validates and formats through Task 1. Non-collect observation may inspect at most 10 tables under one global response budget; collection/continuation requires exactly one.

- [ ] **Step 5: Write RED artifact/token tests before filesystem implementation**

  Use a task-local runtime root. Prove 0700 directory and 0600 files; atomic no-clobber writes; target/session binding; opaque token grammar and maximum length; traversal/absolute/encoded-path/stale/wrong-target/wrong-session/tampered token rejection before read; bounded chunk continuation; full checksum; partial artifact truth; report visibility; and session cleanup.

- [ ] **Step 6: Implement private artifact/continuation GREEN**

  Store `manifest.json` and `rows.tsv` under a runtime-owned artifact ID. Public JSON may expose a bounded logical artifact ID/token but must not leak machine-local absolute paths; report may expose redacted task-local artifact stats under the existing privacy contract.

- [ ] **Step 7: Add CLI/daemon/MCP-shaped semantics guards**

  Prove observation and continuation are read-only; malformed token is nonzero/`isError`; default text remains bounded; JSON schema/model bytes remain under 16,384; ordinary page data shaped like a table-result schema is not reclassified as transport failure.

- [ ] **Step 8: Run focused tests, lint, dispatch inventory check, and commit periodically**

  Keep RED, runtime GREEN, and any mechanically regenerated runtime-dispatch fixture as separate commits.

---

### Task 3: Genuine virtualized-table collection and live regression

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/cdp.test.mjs`
- Create: `tests/table-collection.test.mjs`
- Create: `scripts/validation-table-collection.mjs`
- Create: `tests/validation-table-collection.test.mjs`
- Modify only if needed for replacing false reassurance: `scripts/benchmark-killer-path.mjs` and its directly covering test.

**Interfaces:**
- Consumes Task 1 accumulator and Task 2 artifact writer.
- Produces: one bounded collector that samples the explicit table, scrolls the explicit container, and optionally activates the explicit load-more control.
- Produces: recycling evidence from a daemon-owned in-page `WeakMap<tr, nodeId>`; identity comes only from `aria-rowindex` or configured key column.
- Produces: a deterministic loopback `virtual-grid-v1` fixture and current-tree evidence bundle.

- [ ] **Step 1: Write RED collector tests against a real recycling controller seam**

  Freeze the issue fixture: 1,024 logical rows, four columns, 12 stable mounted `<tr>` identities, 128 initially loaded, 64 added per load interaction, exactly 14 load-more interactions, final canonical checksum `73e9f36080b8c781e204857ad9c7dcf4ce7ce419b1503d9affd0343f58f964ed`.

- [ ] **Step 2: Verify RED catches current mounted-only behavior**

  It must fail because current production retains only the current 12 rows and has no bounded artifact/completeness contract, not because the fixture or mocks are missing.

- [ ] **Step 3: Implement the smallest collector loop GREEN**

  Sample before and after each scroll/load phase; record rows before interacting; use condition-based progress (new key, changed extent, control disappearance) rather than fixed sleep; final-sweep the clamped maximum scroll position; stop truthfully on all fixed ceilings; never auto-retry a load interaction after ambiguous completion. Do not reuse standalone `loadAllStr`'s prose response as termination evidence; the collector owns and records structured interaction/progress state.

- [ ] **Step 4: Add adversarial RED/GREEN cases**

  Cover duplicate legitimate row text with distinct keys, key conflict, reordered rows, row content mutation, disappearing/reappearing controls, inaccessible/incorrect container, detached table, zero-height/non-scrollable container, cross-frame selector refusal, stalled recycling, byte/row/time/interaction limits, and cleanup after thrown CDP errors.

- [ ] **Step 5: Build the Validation Lab runner test-first**

  The runner launches only after static review; it uses fresh task-local Chrome-for-Testing/profile/HOME/TMPDIR/XDG runtime, about:blank direct fixture provisioning, one CLI route, one MCP route, and an independent Playwright truth route. Retain bounded raw hashes/prefix/suffix before assertions, bind full target/profile/port identities, mode 0600 evidence, exact call/time/output budgets, and memoized signal-safe cleanup.

- [ ] **Step 6: Obtain independent static C/I review before live launch**

  Do not start a browser until signal handling, evidence order, lock ownership, server publication, privacy, and cleanup are reviewed clean.

- [ ] **Step 7: Run two fresh live repetitions**

  Each must prove 1,024 unique rows, 12 stable recycled nodes, 14 load interactions, bounded inline output, exact manifest row/byte/checksum, parsed CLI/MCP semantic parity, independent Playwright truth, no personal paths/secrets, and no process/port/profile/runtime/artifact/lock leftovers.

- [ ] **Step 8: Commit collector, validation tests, and evidence-registry changes separately**

  Do not commit generated live evidence containing machine paths; commit only deterministic fixtures/runner/tests and claim-honest summarized evidence if the repository pattern requires it.

---

### Task 4: Catalog authority, MCP ergonomics, schemas, v2.16 contracts, and docs

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/lib/command-surface.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/command-surface.test.mjs`
- Modify: `tests/command-application.test.mjs`
- Modify: `tests/mcp-contract.test.mjs` or the current MCP adapter/server contract test files selected by repository discovery.
- Create: `docs/schemas/table-result.v1.json`
- Create: `docs/schemas/table-export-manifest.v1.json`
- Create: `docs/contracts/v2.16.0/public-contracts.v1.json`
- Create: `docs/contracts/v2.16.0/runtime-dispatch.v1.json`
- Create: `docs/contracts/v2.16.0/package-entries.v1.json`
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `docs/contracts/README.md`, generator/checker/version registries, release-package inventory, generated `README.md`, `docs/reference.md`, and `skills/chrome-cdp-ex/references/commands.md` only through their owning generator.

**Interfaces:**
- Consumes the completed runtime from Tasks 1-3.
- Produces a first-class MCP `table` tool mapped to the same CLI engine and always requesting JSON.
- Produces catalog-authoritative conditional confirmation: observe/continue no confirmation; `--collect` confirmation required; all table invocations serial in batch unless the existing argv-aware classifier can prove observation-only safely.
- Produces an unreleased v2.16.0 contract directory without changing v2.15.0 fixtures.

- [ ] **Step 1: Write RED command-surface and MCP tests**

  Preserve 81 CLI commands and three MCP resources; increase first-class MCP tools from 25 to 26. Prove exact schema, mapper argv, selector/continuation exclusivity, `confirm:true` required for collect and rejected when missing/accessor/inherited/non-enumerable, zero RuntimeClient effects on denial, and normal observation/continuation without confirm.

- [ ] **Step 2: Implement catalog/MCP GREEN from one authority record**

  Add no parallel allowlist bypass and no duplicate confirmation logic outside existing catalog/adapter policy seams. Update the daemon application's existing exact conditional-command allowlist so catalog-authorized `table --collect` reaches the handler while non-collect calls remain read-only. `run_command table` and first-class `table` must converge on identical canonical argv/semantics.

- [ ] **Step 3: Add and validate JSON Schemas**

  Schemas are closed (`additionalProperties:false` where repository policy expects), bounded, enum-constrained, and distinguish nullable unknown counts from absent fields. Add valid/invalid fixtures for oversized tokens, negative counts, false completeness, leaked absolute paths, missing checksum scope, and unknown provenance.

- [ ] **Step 4: Create v2.16 contract fixtures and version plumbing**

  Bump package metadata to `2.16.0` as unreleased, update checkers to select the package version, generate a new v2.16 directory, and leave v2.15 bytes unchanged. Mechanical fixture refreshes are separate commits and manually reviewed before acceptance.

- [ ] **Step 5: Generate claim-honest documentation**

  Remove unqualified `Full table data` and `no row limit`. Document bounded preview, completeness states, explicit virtual collection, private artifact/continuation, stable identity requirements, confirmation, fixed ceilings, unsupported cases, and that standalone `loadall` does not preserve recycled rows.

- [ ] **Step 6: Run the full acceptance gate**

  Run full tests, lint, docs generator/checker, public contracts, host validation, runtime-dispatch check, actual `npm pack` into a temporary directory, tarball public-contract check, and release-package checker. Verify no tracked/untracked generated drift in the feature worktree.

- [ ] **Step 7: Independent whole-branch review and PR flow**

  Require no open Critical/Important findings, rerun any amended focused tests, push the periodic commit history, open a ready PR against `EndeavorYen/chrome-cdp-ex:main`, wait for CI, address review, merge, synchronize `main`, close #151, delete the remote/local feature branch and worktree, and run a post-merge focused smoke. Do not publish npm or create the v2.16 GitHub Release in this plan.
