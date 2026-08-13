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
- Public v2.16 grammar has no caller-tunable limit flags. Fixed bounds are: selector 1,024 UTF-8 bytes, 256 direct cells per row, 4,096 canonical bytes per row, 20 inline data rows, 16,384 UTF-8 bytes per formatted JSON response, 100,000 unique data rows, 16,777,216 artifact bytes, 256 page mutations, three no-progress cycles, 295,000 ms mutation window, 300,000 ms server total, and 315,000 ms IPC response deadline.
- `logicalRows` comes only from explicit semantic evidence such as `aria-rowcount`; never infer it from captions, prose, or `data-source-rows`.
- `complete` requires known logical count, safe termination, and exact one-based `aria-rowindex` coverage of every index `1..logicalRows`. Count equality alone never proves completeness. Row-key-only collection remains `unknown` even when counts happen to match.
- Virtual collection requires exactly one HTML table, an explicit `--scroll-container`, and stable identity from `aria-rowindex` or zero-based `--row-key-column N` (`0..255`). Duplicate identity inside one mounted snapshot fails; cross-cycle same-key/same-bytes is benign/no-progress; same-key/different-bytes is a conflict; never deduplicate by row text.
- `--collect` is the only mutating mode. The explicit CLI flag is the CLI acknowledgement; first-class MCP and MCP `run_command` additionally require `confirm:true`. Observation and immutable `--continue` are reads. Never automatically replay an interaction after daemon/transport ambiguity.
- Catalog conditional policy, batch safety, daemon authorization, MCP confirmation, and transport side-effect classification must land before any collector implementation can scroll or click.
- Collection stops starting mutations at 295 seconds, reserves five seconds to publish a partial result by 300 seconds, and uses a 315-second client IPC deadline. Caller disconnect aborts all further interactions, deletes unpublished state, and never replays.
- Continuation is immutable, row-aligned, and idempotent: the same token always names the same artifact offset and returns the same table slice plus a distinct next token. Tokens never mutate a server cursor; a row over 4,096 canonical bytes terminates as `row-too-large` and is never cut or skipped.
- Artifacts are runtime-owned only: no caller paths; validated nonsymlink POSIX root owned by the current UID; 0700 directories; 0600 regular files; exclusive writes; fsync; whole-directory atomic rename with manifest written last; target/session/artifact binding; lazy bounded orphan reclamation; synchronous temp cleanup on failure/abort/shutdown. Artifact-producing modes fail closed on Windows in v2.16 until private ACL verification exists.
- Full artifact checksum is SHA-256 over exact UTF-8 canonical data-row `rows.tsv` bytes: tab between cells, LF between rows, no header and no final LF. Issue #151's 1,024-row fixture must produce `73e9f36080b8c781e204857ad9c7dcf4ce7ce419b1503d9affd0343f58f964ed`.
- MCP and CLI must use the same runtime engine. Compare parsed semantics and artifact hashes while ignoring only the CLI terminal newline and explicitly enumerated volatile IDs/paths/timestamps.
- No personal browser profile, login, external mutation, or npm publication. Each live CLI, first-class MCP, MCP run-command, and Playwright route uses its own independently reset task-local browser/target/profile/runtime fixture and proves cleanup.
- Scope is Critical/Important agent harm only. Do not fold in heuristic container discovery, multi-table collection, caller output paths, arbitrary dynamic MCP resources, or unrelated cleanup.

---

### Task 1: Pure table truth, canonicalization, and budgeting

**Files:**
- Create: `skills/chrome-cdp-ex/scripts/lib/table-extraction.mjs`
- Create: `tests/table-extraction.test.mjs`

**Interfaces:**
- Produces: immutable `TABLE_EXTRACTION_LIMITS` with the fixed ceilings above.
- Produces: `canonicalizeTableCells(cells) -> string`, where backslash, tab, CR, and LF are escaped deterministically before tab-joining cells.
- Produces: `createTableAccumulator({ logicalRows, logicalCountSource, identitySource, orderingSource })`, `addTableSample(accumulator, sample)`, and `addTableSampleBatch(accumulator, samples)` for strict aria coverage, within-snapshot duplicate rejection, benign cross-cycle repeats, row-conflict detection, mounted-node recycling evidence, and canonical byte accounting.
- Produces: `finalizeTableExtraction(accumulator, { termination, limits }) -> chrome-cdp-ex.table.v1` and `buildTableExportManifest(...) -> chrome-cdp-ex.table-export.v1`.
- Produces: `buildInlineTablePreview(rows, limits)` that truncates only at complete UTF-8 row boundaries, rejects rows over 4,096 canonical bytes, and reports exact row/byte counts.
- Later tasks consume these functions; this task has no filesystem or CDP effects.

- [x] **Step 1: Write independent failing tests for truthful mounted observation**

  Add literal fixtures proving 12 mounted rows with `aria-rowcount=1024` report `logicalRows:1024`, `mountedRows:12`, `collectedRows:12`, and `completeness.state:"incomplete"`; missing logical evidence reports `logicalRows:null` and `state:"unknown"`.

- [x] **Step 2: Run the new test file and verify RED**

  Run `npm test -- tests/table-extraction.test.mjs`. Expected: module/export-not-found failures only.

- [x] **Step 3: Implement the minimal pure observation model and make those tests GREEN**

  Validate all inputs as own plain data; reject accessors, custom prototypes, symbols, sparse arrays, non-string cells, non-finite/negative counts, and unknown provenance enums before deriving output.

- [x] **Step 4: Add RED tests for canonical bytes and bounds**

  Use hand-derived strings for escaping, multibyte rows, exactly-8,192-byte boundaries, 20-row preview, 16,384-byte response pressure, and the fixed 1,024-row checksum. Tests must assert complete-row truncation and no replacement-character corruption.

- [x] **Step 5: Implement canonicalization, preview, checksum, and manifest GREEN**

  Hash exact `Buffer.from(rowsTsv, "utf8")`; `inline.bytes` is the included preview byte count and `artifact.bytes` is the full canonical body byte count.

- [x] **Step 6: Add RED tests for recycling, conflicts, and stop reasons**

  Freeze cases for the same mounted node carrying different keys, duplicate keys within one batch, benign same-key repeats across batches, duplicate keys with conflicting bytes, exact `1..logicalRows` coverage, out-of-domain aria indices, row-key non-certification, unknown totals, logical-count reached, row-too-large, row/byte/interaction/time/no-progress limits, and partial-artifact truth.

- [x] **Step 7: Implement accumulator semantics and run focused GREEN**

  Run `npm test -- tests/table-extraction.test.mjs`; then run lint on both new files.

- [x] **Step 8: Commit Task 1 in small checkpoints**

  Commit the verified RED first, then the pure GREEN implementation. Do not touch runtime/catalog/docs in these commits.

---

### Task 2: Parse once, then establish authorization and side-effect authority

**Files:**
- Create: `skills/chrome-cdp-ex/scripts/lib/table-contract.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/lib/command-surface.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/lib/daemon-read-handlers.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: the directly covering command-surface, application, MCP, batch, transport, and runtime-inventory tests.

**Interfaces:**
- Produces one strict own-data argv parser and `isTableCollectArgs(args)` used by every policy boundary.
- Public grammar is exactly observation, explicit `--collect`, or immutable `--continue`; collection-only flags without `--collect` fail before capability effects.
- Catalog effect/authorization is conditional: observation and continuation are reads; collection is a protected mutation.
- CLI `--collect` is explicit acknowledgement. First-class MCP and MCP `run_command` require own-data `confirm:true` before RuntimeClient execution.

- [ ] **Step 1: RED the exact parser grammar and argv forwarding**

  Cover duplicates, empty strings, unknown flags, selector ambiguity, UTF-8 selector bound, zero-based row-key range, mutual exclusion, continuation grammar, proxies/accessors/custom prototypes/symbols/sparse arrays, and full ordered argv delivery to the table capability.

- [ ] **Step 2: Implement parser and fail-closed pre-collector behavior**

  Until Task 6 lands, a valid collect request returns an explicit unavailable error before page effects. Snapshot behavior remains usable; invalid continuation never touches storage.

- [ ] **Step 3: RED catalog, MCP, batch, and transport classifications**

  Prove collect requires confirmation in both MCP routes, is unsafe in parallel batch, and is side-effect-capable after IPC send; observation/continuation remain read-only and parallel-safe. Canonical aliases and nested composite inspection must not bypass the predicate.

- [ ] **Step 4: Implement one authority path and verify zero-effect denials**

  Update the exact conditional-command allowlist and catalog-owned policy. Do not duplicate argv heuristics. Denied/inherited/accessor/non-enumerable confirmation reaches zero RuntimeClient/capability calls.

- [ ] **Step 5: Run focused checks and commit RED, GREEN, and generated inventory separately**

  Runtime inventory mutations that swap table policy, builder wiring, or argv-aware classification must drift or reject.

---

### Task 3: Request-specific deadlines and disconnect cancellation

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: dispatcher/application context plumbing only where needed.
- Modify: `tests/daemon-transport.test.mjs` and the directly covering server/dispatcher tests.

**Interfaces:**
- Selects 315,000 ms only for `table --collect`, capped even for internal overrides; existing wait-specific behavior is unchanged.
- Creates one `AbortController` per active request ID and threads its signal to the eventual collector.
- Aborts on connection end/close/error and signal shutdown; duplicate active IDs reject; a disconnected client receives no response and causes no later interaction.

- [ ] **Step 1: RED request timeout selection and typed timeout cleanup**

  Freeze 295,000 ms mutation, 300,000 ms server, 315,000 ms IPC, and 5,000 ms per-CDP-operation limits. Timeout remains completion-unknown/no-auto-replay after a collect request was sent.

- [ ] **Step 2: RED server-side abort behavior**

  Destroy a connection during an abortable collector seam and prove no subsequent click/scroll, unpublished temp cleanup, guarded response writes, listener removal, and exactly-once request disposal.

- [ ] **Step 3: Implement minimal signal plumbing GREEN**

  Every loop, sleep, and CDP operation must observe the signal. Serialization failure before send remains pre-dispatch; post-send response loss remains conservatively ambiguous under #150's contract.

- [ ] **Step 4: Focused verify and commit small checkpoints**

  Do not add a real collector in this task.

---

### Task 4: Private immutable artifacts and row-aligned continuation

**Files:**
- Create: `skills/chrome-cdp-ex/scripts/lib/table-artifacts.mjs`
- Create: `tests/table-artifacts.test.mjs`
- Modify only the minimal runtime/session cleanup seams and their tests.

**Interfaces:**
- Artifact IDs are 32 lowercase hex characters. Tokens are exactly `ct1.<artifactId>.<zeroBasedDataRowOffset>` and never exist at EOF.
- `rows.tsv` contains only canonical data rows, so issue #151's artifact is exactly 31,104 bytes with checksum `73e9…64ed`.
- Continuation returns at most 20 whole rows and at most 16,384 formatted JSON bytes; the same token returns byte-identical table payload and a distinct immutable next token.
- POSIX publication is runtime-owned, nonsymlink, UID/mode checked, exclusive, fsynced, and whole-directory atomic. Windows artifact-producing modes fail closed in v2.16; observation remains available.

- [ ] **Step 1: RED hostile root, publication, and tamper cases**

  Cover traversal, absolute/encoded paths, symlinks, non-regular files, wrong UID/mode, no-clobber rename, target/session mismatch, stale manifest, checksum/size mismatch, partial write, fsync/rename failure, and no absolute path leakage.

- [ ] **Step 2: Implement atomic store GREEN**

  Write data then manifest into a 0700 exclusive temp directory with 0600 files, fsync, rename without replacement, and verify real paths remain under the validated root.

- [ ] **Step 3: RED continuation boundaries and idempotence**

  Parse the strict token before filesystem reads. Verify regular-file bytes/hash, offsets, whole-row boundaries, maximum 20 rows, worst-case 4,096-byte canonical row, no EOF token, repeated token byte equality, and row-too-large valid-prefix behavior.

- [ ] **Step 4: Implement continuation and bounded cleanup GREEN**

  Remove unpublished temps synchronously on failure/abort/shutdown. Lazily sweep nonsymlink temp entries older than 15 minutes and published artifacts older than 24 hours; unknown types remain visible and undeleted.

- [ ] **Step 5: Focused verify and commit RED/GREEN separately**

---

### Task 5: Trusted bounded DOM sampling and truthful observation

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/cdp.test.mjs`
- Create only if source size warrants it: `skills/chrome-cdp-ex/scripts/lib/table-sampler.mjs` and its focused test.

**Interfaces:**
- Replaces mounted-only prose extraction with `chrome-cdp-ex.table.v1` observation using Task 1 truth functions.
- Samples HTML tables only. Header rows are direct rows of `thead`; data rows are direct rows of `tbody` or direct rows of `table`; `tfoot` and nested tables are excluded; direct `th`/`td` cells only; no span expansion; at most 256 cells per row.
- Uses a trusted isolated world and captured intrinsics/getters. It never calls page callbacks or page-world helpers.
- One sample returns at most 128 rows and 524,288 serialized UTF-8 bytes. Default observation may inspect at most 10 tables under one aggregate 524,288-byte page-response budget; collection later requires exactly one table.

- [ ] **Step 1: RED real CDP result shapes and page hostility**

  Cover no/static/virtual/multiple/nested/footer tables, caption/data-attribute false totals, malformed ARIA, patched prototypes/getters/toJSON/JSON/TextEncoder, huge cells, UTF-8/control text, cross-frame refusal, and oversized serialized samples.

- [ ] **Step 2: Implement isolated bounded sampler GREEN**

  Capture trusted traversal/text/attribute primitives, compute serialized byte pressure before return, and emit explicit unsupported/truncation provenance instead of allowing an unbounded CDP result.

- [ ] **Step 3: Integrate bounded snapshot text and JSON**

  Snapshot never scrolls/clicks, never presents mounted rows as full, and stays within the response envelope. Preserve static-table agent ergonomics with header metadata and a bounded complete preview.

- [ ] **Step 4: Verify characterization/source gates and commit**

---

### Task 6: Persistent isolated-world virtual collection

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/lib/daemon-read-handlers.mjs`
- Create: `tests/table-collection.test.mjs`
- Modify: the direct application/daemon/workflow tests needed for end-to-end semantics.

**Interfaces:**
- One active collector per daemon/session; a second returns `collector-busy`.
- One persistent isolated execution context owns captured intrinsics, a token-keyed `WeakMap<Node, integer>` for mounted-node identity, and original scroll state; one CDP object group is always released.
- The loop samples before and after each interaction, uses explicit scroll container, optionally clicks explicit load-more by CDP mouse dispatch, final-sweeps the clamped maximum, and never auto-retries ambiguous interactions.

- [ ] **Step 1: RED the genuine recycled-node fixture**

  Freeze 1,024 logical rows, four columns, 12 stable mounted nodes, 128 initially available, 64 per load interaction, exactly 14 interactions, exact 31,104-byte body, and checksum `73e9f360…964ed`. RED must fail on current mounted-only behavior, not missing mocks.

- [ ] **Step 2: RED context, abort, and deadline lifecycle**

  Cover execution-context destruction, root navigation/detach, caller disconnect, collector-busy, 295-second no-new-mutation fence, partial publication by 300 seconds, and object-group/listener/temp cleanup on every exit.

- [ ] **Step 3: Implement the smallest condition-driven collector GREEN**

  Progress means new stable identity, changed scroll extent, or control disappearance—not fixed sleep. `aria-rowcount` must be absent/`-1` throughout or one stable safe integer; drift terminates truthfully. Exact ARIA coverage alone can certify complete; row-key mode cannot.

- [ ] **Step 4: Add adversarial collection cases**

  Cover duplicate mounted node/key, conflicts, remount/reorder, disappearing/reappearing controls, wrong/non-scrollable container, detached table, stalled recycling, large row, byte/row/interaction/time/no-progress limits, and thrown CDP operations.

- [ ] **Step 5: Wire artifact publication and full command semantics**

  CLI JSON/text, daemon, first-class MCP, run-command MCP, batch, flow, repeat, and replay preserve the same result/failure/ambiguity semantics. Collect mutates only after authorization and signal installation; continuation never re-enters the page.

- [ ] **Step 6: Focused/full runtime verification and periodic commits**

---

### Task 7: First-class MCP, schemas, v2.16 contracts, and claim-honest docs

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/lib/command-surface.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs`
- Modify: MCP/public-contract tests.
- Create: `docs/schemas/table-result.v1.json`
- Create: `docs/schemas/table-export-manifest.v1.json`
- Create: the v2.16.0 contract fixtures owned by repository generators.
- Modify: package/version/checker registries, `CHANGELOG.md`, contract README, release-package inventory, and generated command docs through their owners.

**Interfaces:**
- Preserves 81 CLI commands and three MCP resources; adds one first-class `table` tool, increasing first-class tools from 25 to 26.
- First-class MCP and `run_command` converge on the same canonical argv/runtime engine; only collect requires `confirm:true`.
- v2.15 fixture bytes remain unchanged; v2.16 is unreleased in this plan.

- [ ] **Step 1: RED first-class MCP schema/mapper and malformed confirmation**

  Cover selector/continue exclusivity, collect confirmation, zero-effect denial, aliases, exact argv, JSON output, prototype/accessor/non-enumerable/symbol/proxy input, and semantic parity with run-command.

- [ ] **Step 2: Implement MCP and closed schemas GREEN**

  Schemas bound every string/count/list and reject false completeness, leaked absolute paths, oversized tokens, negative counts, missing checksum scope, and unknown provenance.

- [ ] **Step 3: Add v2.16 version/contract plumbing**

  Bump package metadata to unreleased 2.16.0 only when all runtime behavior is green. Generate new fixtures; never rewrite `docs/contracts/v2.15.0/*`. Keep mechanical commits separate.

- [ ] **Step 4: Generate honest docs**

  Remove `Full table data`/`no row limit`. Explain bounded observation, completeness, explicit virtual collection, private continuation, fixed ceilings, confirmation, unsupported cases, and why standalone `loadall` does not preserve recycled rows.

- [ ] **Step 5: Run full source and packed-artifact gates**

  Full tests, lint, docs, generated surfaces, public contracts, host validation, runtime inventory, actual temp `npm pack`, tarball contracts, release-package inventory, privacy scan, and diff checks must pass.

---

### Task 8: Four-route live acceptance, independent review, and PR/merge

**Files:**
- Create: `scripts/validation-table-collection.mjs`
- Create: `tests/validation-table-collection.test.mjs`
- Modify deterministic evidence registry only if repository policy requires it.

- [ ] **Step 1: Build Validation Lab runner test-first**

  Every trial uses four separately reset task-local browser/target/profile/runtime fixtures: direct CLI collect, first-class MCP collect, MCP run-command collect, and an independent Playwright oracle that imports no chrome-cdp-ex extraction code. Use about:blank direct fixture provisioning to avoid #144.

- [ ] **Step 2: Freeze evidence-first and cleanup contracts**

  Retain bounded argv/status/length/hash/prefix/suffix before parsing/assertions; bind full target/profile/port/runtime identities; use mode 0600 evidence; memoize signal cleanup; stop daemon before browser; prove endpoint/process/profile/runtime/artifact/lock removal. No raw 1,024-row payload is retained.

- [ ] **Step 3: Obtain independent static C/I review before browser launch**

  Signal handling, lock ownership, server publication, privacy, freshness, deadlines, evidence order, and cleanup must be Ready.

- [ ] **Step 4: Run two fresh trials (eight independent routes)**

  Every route starts at 128 available rows, 12 stable nodes, zero clicks and proves 1,024 exact indexes, recycling, exactly 14 interactions, exact body checksum, artifact/manifest integrity, all JSON records ≤16,384 bytes, repeated continuation byte identity, CLI/MCP semantic parity, and no leftovers.

- [ ] **Step 5: Whole-branch acceptance**

  Require no Critical/Important review findings and rerun amended gates. Commit deterministic runner/tests and claim-honest summaries separately; never commit personal paths or raw table data.

- [ ] **Step 6: Push, ready PR, review, merge, and post-merge proof**

  Push periodic history, open against `EndeavorYen/chrome-cdp-ex:main`, wait for CI, address review, merge, sync main, close #151, remove feature branch/worktree, and run a post-merge focused smoke. Do not publish npm or create a v2.16 GitHub Release in this plan.
