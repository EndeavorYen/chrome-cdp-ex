# Browser Runtime v3 Architecture

Status: Phase 2 contract freeze, Phase 3 Validation Lab, Phase 4 command-core
slices, Phase 5 resource supervision/direct MCP routing, and Phase 6
single-owner surfaces/exact CDP domains are implemented.

Runtime v3 is a compatibility-preserving refactor of chrome-cdp-ex, not a new
browser engine. The current v2.15 runtime keeps one resident daemon per tab.
CLI still enters through `cdp.mjs`; MCP now invokes an in-process runtime client
instead of spawning the CLI for each tool request. The components below state
both the implemented boundary and the remaining target architecture.

## Why change

The existing runtime has accumulated 81 commands, browser discovery, CDP
transport, target binding, perception, mutation evidence, recovery, recording,
and output formatting in one large module. That design has strong behavior
coverage but gives CLI dispatch, MCP mapping, help text, and runtime policy
separate owners. Large edits therefore carry unnecessary compatibility risk.

Runtime v3 makes public contracts explicit first, then moves one tested slice at
a time behind the existing CLI and MCP surfaces.

## Invariants

1. Node.js 22+, ESM, zero runtime dependencies, and current package entry points
   remain intact unless a separately reviewed versioned migration changes them.
2. Metadata for all 81 canonical commands, aliases, output formats, public JSON
   schemas, CLI/MCP compatibility, and representative browser-independent CLI
   exit and error behavior remain frozen by versioned fixtures. Phase 3 adds
   replay coverage for browser-dependent behavior before runtime extraction.
3. The existing per-tab resident runtime stays in place while a browser-level
   supervisor is introduced around it.
4. Public resources are serializable and stable enough to log; private CDP
   sessions, object IDs, backend node IDs, and sockets are never public handles.
5. Browser mutations keep authorization, before/after evidence, settle policy,
   recovery guidance, redaction, and audit classification.
6. Raw JavaScript and CDP remain governed escape hatches rather than bypasses.
7. Workflows offer explicit preconditions, postconditions, checkpoints,
   fail-fast/continue policy, and bounded compensation. They do not promise a
   general browser transaction or rollback.

## Target layers

```text
CLI adapter                 MCP adapter
     \                         /
      Command registry + application execute()
                       |
      policy, result, error, evidence contracts
                       |
       browser resource resolver / locator plans
                       |
       browser supervisor and per-tab runtimes
                       |
        typed CDP domain clients and transport
```

Adapters parse and render. They do not own command behavior. Phase 4 added an
immutable `CommandSpec` registry and shared application `execute()` boundary for
`perceive`, `click`, `report`, and `evalraw`. Phase 6 makes the dependency-free
command surface the single immutable owner of all 81 command policy, alias,
help, domain, and MCP records. Runtime `COMMANDS`, target routing, application
specs, generated help/index regions, and MCP definitions derive from that
validated owner. Phase 5 added immutable public browser
resources and locator plans, a private resolved-handle boundary, supervised
per-tab daemon reuse/recovery, and a direct in-process MCP runtime client. The
daemon compatibility adapter preserves v2.15 output while the internal
execution record carries bounded policy and evidence metadata.

## Current implementation boundary

Phase 4 ships the dependency-free application core and routes one read, one
mutation, one evidence, and one raw-CDP command through it. Mutation and raw-CDP
routes fail closed without the daemon's explicit compatibility authorization;
raw audit metadata records only the method and a conservative side-effect
class. A disposable Chrome for Testing scenario exercises the four real
CLI/daemon routes without using a personal profile or authenticated state.

Phase 5 implements the first bounded resource graph and locator-plan contracts,
the browser supervisor around existing per-tab daemons, extracted daemon
transport, and the direct MCP-to-runtime path. Disposable Chrome for Testing
evidence exercises CLI and direct MCP parity, daemon stop/restart, stale target
replacement, bounded re-resolution, action evidence, and cleanup. The existing
per-tab daemon remains the owner of tab-scoped runtime state.

Phase 6 also routes every normal, reviewed CDP call through exact-method domain
clients. The separately branded raw gateway is available only after raw-CDP
authorization and records method plus side-effect class without params or
results. The compatibility facade and 77 explicitly enumerated legacy command
routes remain executable; removing only superseded dispatch paths is Phase 7
work.

## Browser Resource Graph

Runtime v3 uses typed resources rather than one universal browser node tree.
Examples include browser, browser context, page target, frame, DOM node,
accessibility node, network request, storage scope, screenshot, recording, and
evidence bundle. Resources share an envelope—kind, stable identity where
possible, revision, capabilities, and links—but retain domain-specific payloads.

The public boundary is:

```js
{
  resource: { kind, id, revision, capabilities, links },
  locator: { strategy, value, scope, fallbacks }
}
```

This `ResourceRef + LocatorPlan` boundary is implemented and serializable.
Resolution yields a branded private `ResolvedHandle` containing volatile CDP
details. Private handles are scoped to supervised runtime use and are never
written to public evidence or replay fixtures. Resource and locator inputs are
bounded, immutable, secret-free, and fail closed on ambiguous resolution.

## Execution lifecycle

Reads use a common authorize → resolve → execute → classify → render pipeline.
Mutations use:

```text
authorize → resolve → capture before → execute → settle
          → capture after → classify change → attach evidence → render
```

Raw CDP and JavaScript add explicit side-effect classification, timeout,
redaction, and audit metadata. Compatibility rendering initially preserves
current stdout, stderr, JSON payloads, and exit codes; later envelopes require a
versioned public decision.

## Runtime topology

The current per-tab daemon is a useful cache and event boundary and is not
discarded. Phase 5 introduces a Browser Supervisor responsible for discovery,
tab-runtime lifecycle, shared transport health, bounded stale-resource recovery,
and routing. Each tab runtime retains tab-scoped state such as refs, action
history, console/network buffers, and recordings. MCP calls the same in-process
CLI/runtime boundary through a strict `RuntimeClient`; there is no fallback that
spawns the CLI. Compatibility tests and disposable-browser evidence prove parity
for the migrated and representative legacy commands.

## Migration sequence

1. Phase 2 froze v2.15 public contracts and recorded this architecture.
2. Phase 3 built the local Validation Lab, replay, fingerprints, and failure
   classification without changing public runtime behavior.
3. Phase 4 implemented core contracts and routed `perceive`, `click`, `report`,
   and `evalraw` as read, mutation, evidence, and raw vertical slices.
4. Phase 5 added resource resolution and supervision, then removed MCP's
   per-request CLI spawn after parity evidence.
5. Phase 6 gives command metadata one owner and converges generated CLI, MCP,
   docs, permissions, and typed CDP domains.
6. Phase 7 removes only superseded dispatch paths and runs the full Runtime v3
   release-candidate gate.

At every step, the compatibility facade stays executable. A failed fixture,
live scenario, package gate, or independent review blocks removal of the old
path; it does not justify rewriting the fixture to match accidental drift.

## Phase 7 deletion boundary

Before Phase 7 removes a branch, the versioned
`docs/contracts/v2.15.0/runtime-dispatch.v1.json` fixture records its exact
source digest, aliases, canonical command owner, and allowed deletion scope.
The pre-deletion boundary contained 81 commands, 23 aliases, 13 targetless CLI
adapters, 68 target commands, 73 daemon switch groups, four application-owned
handlers, and 64 legacy daemon branches. The first Phase 7 extraction cohort
moved `html`, `text`, and `table`; the second moved `net`/`network`, `status`,
and `summary`; the third moved `snap`/`snapshot`, `controls`, and
`frame`/`frames`; the fourth moved `overlay`/`overlays`, `styles`, `components`,
`record-actions`/`recordactions`, and `export-playwright`/`export-pw`; the fifth
moved `wait`, `waitfor`, and `cascade`; the sixth moved `checkpoint` and
`cookies`; the seventh moved `fill`, `hover`, `press`, `scroll`, and `select`.
The eighth moved `jsclick`, `clickxy`, `type`, `verify-click`, and
`dismiss-modal`; the ninth moved `nav`/`navigate`, `back`, `forward`, and
`reload`; the tenth moved `mock`/`network-mock`, `clock`/`time-travel`, and
`throttle`/`network-throttle`; the eleventh moved `viewport`/`resize` and
`emulate`; the twelfth moved `cookieset`, `cookiedel`, `dialog`, `keepalive`,
and `netlog`. The current checked boundary has 30 daemon groups,
47 application-owned handlers, and 21 remaining switch-branch
deletion candidates.

The daemon now preflights a complete, immutable route-owner map before runtime
effects and constructs one branded dispatcher from it. All 81 canonical names
and 23 aliases resolve through that boundary; the four Phase 4 commands, the
six accepted read cohorts, and the first six action cohorts execute application
handlers, while the other 34 catalog commands return an explicit
`handled: false` result to the characterized legacy switch. This is a routing
and cardinality guarantee, not a claim that the remaining handlers have moved.

Only a listed legacy `handleCommand` branch may be deleted, and only after its
replacement passes direct CLI, daemon-wire, recursive workflow, MCP, policy,
output/error, and live evidence parity. Protocol controls (`meta`, `list`,
`list_raw`, and daemon `stop`), daemon state and event buffers, parsers,
renderers, browser operations, target resolution, BrowserSupervisor topology,
typed CDP domains, and the raw gateway remain explicitly retained authorities.

## Non-goals

- no clean-room rewrite;
- no TypeScript or dependency migration;
- no browser-wide daemon cutover before per-tab parity;
- no universal untyped browser tree;
- no public serialization of volatile CDP handles;
- no claim of atomic browser transactions or universal rollback;
- no removal of legacy paths in the same slice that introduces their replacement.

## Evidence and privacy

Deterministic contract fixtures contain public metadata and browser-independent
CLI behavior only. Live evidence uses disposable local fixtures. Validation
artifacts must redact secrets and exclude personal tabs, cookies, credentials,
authenticated state, absolute user paths, target IDs, ports, and timestamps
unless a specific local-only evidence contract explicitly requires them.
