# ADR 0001: Contract-first strangler migration for Runtime v3

- Status: Accepted
- Date: 2026-08-12
- Decision owners: chrome-cdp-ex maintainers

## Context

chrome-cdp-ex v2.15 exposes 81 commands through a mature CLI, a smaller MCP
surface, public JSON schemas, a zero-runtime-dependency package, and a per-tab
resident runtime. Most implementation still lives in a large `cdp.mjs`, while
MCP starts that CLI for each operation. A previous cloud refactor task left no
production commit to recover.

A clean rewrite would force architecture, transport, public-contract, and
release changes to be validated together. It would also make existing tests
less useful precisely when compatibility risk is highest.

## Decision

Use a contract-first strangler migration.

First, capture v2.15 command metadata, schemas, deterministic CLI exits/output,
MCP definitions and mappings, and package inventory in checked fixtures. Then
introduce the target core behind the current CLI/MCP compatibility facade. Move
one representative vertical slice at a time, keep old and new paths comparable,
and delete a legacy path only in Phase 7 after parity and review.

Preserve the per-tab daemon. Introduce a browser supervisor around it rather
than replacing all runtime topology at once. Model public resources as typed,
serializable references plus locator plans; keep resolved CDP handles private.

## Consequences

Positive:

- accidental public drift fails before runtime extraction is accepted;
- existing characterization tests and live campaigns remain useful;
- each slice is reversible and reviewable;
- CLI and MCP can converge on one application contract without a flag day.

Costs:

- the compatibility facade and some duplicated dispatch survive for several
  phases;
- intentional contract changes require explicit fixture review;
- snapshot quality must be guarded so volatile or private values are not frozen.

## Rejected alternatives

**Clean rewrite:** rejected because it couples too many risks and provides no
incremental compatibility proof.

**TypeScript/dependency migration first:** rejected because it changes tooling
and runtime surfaces without solving command ownership.

**Replace per-tab daemons with one browser daemon immediately:** rejected
because current tab-scoped state and recovery behavior would need simultaneous
reimplementation.

**Keep source-text checks only:** rejected because workflow strings and counts do
not prove actual CLI/MCP/package behavior.

## Review trigger

Revisit this ADR only if a Phase 4 or Phase 5 vertical slice demonstrates that
the compatibility facade cannot preserve a required contract, or if measured
runtime evidence disproves the per-tab-supervisor topology. Record new evidence
in a new ADR; do not rewrite this decision retroactively.
