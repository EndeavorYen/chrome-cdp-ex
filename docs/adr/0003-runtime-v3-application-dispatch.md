# ADR 0003: One catalog-derived application dispatcher for target commands

- Status: Accepted
- Date: 2026-08-12
- Decision owners: chrome-cdp-ex maintainers
- Contract target: unpublished v2.15.0 release candidate

## Context

Runtime v3 began with command behavior spread across direct CLI branches, a
large per-tab daemon switch, MCP command mapping, and four Phase-specific
application handlers. The contract-first migration proved each target-command
family across direct CLI, daemon wire, recursive workflows, MCP, policy,
output/error identity, disposable Chrome for Testing, package boundaries, and
cleanup before deleting its old switch branch.

After the final cohort, all 68 target commands have an application handler.
Thirteen commands remain targetless by design: they own help, browser discovery
and launch, runtime/target selection, tab groups, broadcast, and daemon
lifecycle. The daemon also retains protocol operations and tab-scoped state
that are not application commands.

## Decision

Use the immutable command surface as the sole command metadata and policy
authority. At daemon startup, derive the exact set of target commands from that
catalog and require the handler-builder map to cover it exactly before any
browser or runtime effect. Construct one branded dispatcher with two explicit
route-owner classes:

- `application` for all 68 target commands;
- `adapter` for the 13 intentional targetless CLI commands.

Aliases canonicalize through the same registry. An application command executes
exactly one handler through the shared authorization/result/evidence contract.
An adapter route returns `handled: false` without authorization or handler
execution and continues only through the reviewed direct CLI routing spine.

Retain five daemon protocol groups: `meta`, `list`, `list_raw`, `stop`, and
fail-closed unknown-command handling. Retain BrowserSupervisor and its bounded
stale recovery, the per-tab daemon and event/state buffers, transport framing,
request/response envelopes, parsers, renderers, target resolution, typed CDP
domain clients, and the separately authorized raw gateway. These components
have current owners and are not compatibility debris.

Importing the MCP/runtime surface must remain effect-free: no stdin listener,
filesystem mutation, process-global mutation, browser or subprocess launch, or
socket creation. Runtime effects begin only after an explicit command or the
direct-run MCP server entrypoint.

## Consequences

- There is no target-command legacy switch or second migration list to drift.
- Handler/catalog mismatch fails before runtime effects.
- Targetless lifecycle commands remain explicit adapters rather than artificial
  target handlers.
- v2.15 stdout, stderr, exit codes, MCP payloads, daemon envelopes, and per-tab
  runtime topology remain compatibility boundaries.
- The source inventory freezes the exact CLI routing spine, handler authority,
  protocol groups, recursive edges, and empty deletion list.

## Rejected alternatives

**Delete the per-tab daemon after handler migration:** rejected because it still
owns tab-scoped sessions, refs, event buffers, recordings, and protocol control.

**Turn targetless commands into synthetic target handlers:** rejected because
help, discovery, browser launch, and runtime selection do not have a target
resource and would weaken lifecycle ownership.

**Keep a hand-maintained migrated-command list:** rejected because the catalog
and handler map already provide exact derivable authority.

**Move parsing/rendering into the application core:** rejected for v2.15 because
it would combine dispatch deletion with public output and error-format changes.

## Review trigger

Revisit this decision only for a versioned change to public command topology,
daemon topology, output envelopes, or targetless lifecycle ownership. A new
command must update the catalog and satisfy exact handler/adapter, domain,
public-contract, package, and live-evidence gates before release.
