# Public contract fixtures

This directory contains versioned, machine-readable compatibility baselines for
chrome-cdp-ex. They protect public behavior for the published v2.16 CLI and MCP
runtime. Published v2.15 fixtures remain immutable historical contracts.

## Ownership

`scripts/check-public-contracts.mjs` owns the main public-contract and package
fixtures. `scripts/runtime-dispatch-inventory.mjs` owns only the Phase 7
pre-deletion dispatch fixture. Both default to read-only check mode; fixture
updates require an explicit reviewed write command, and neither checker infers
permission to rewrite a baseline.

The fixture owns command and alias metadata, public schemas (including the
v2.16 `table-result` and `table-export-manifest` contracts), deterministic
browser-independent CLI exits/output, MCP definitions/resources/allowlists and
representative mappings, package metadata, and the actual tar entry inventory.

The current `runtime-dispatch.v1.json` separately owns the Phase 7 pre-deletion
characterization of CLI, daemon protocol, application-handler, and legacy
daemon routing. It is exact to the reviewed source tree; changing a branch
digest or route label requires explicit fixture review before deletion. In a
source checkout, run `node scripts/runtime-dispatch-inventory.mjs --check`; the
checker is development tooling and is intentionally excluded from release
packages while the reviewed fixture is shipped with the other contracts.

## Canonicalization

Objects use recursively sorted keys and files end with one LF. Arrays are sorted
only when order is not public. Command order, argument order, and mapping-case
order remain explicit. Sets become sorted arrays.

The baseline excludes timestamps, durations, absolute paths, usernames, temp
directories, ports, browser target IDs, personal browser state, live page
output, tarball hashes, and private CDP handles.

## Review policy

A changed fixture is not proof that a change is compatible. Reviewers must
inspect the bounded diff, classify it as intentional or accidental, and require
the relevant behavior/live/package evidence before accepting an intentional
change. CI and release validation use check mode only.

Version directories are immutable historical contracts after publication. A
new intentional public contract belongs in a new version directory; corrections
to an unpublished local candidate must retain RED/GREEN evidence in the local
run log.
