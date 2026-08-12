# ADR 0002: Command authorization is not the legacy `mutates` flag

- Status: Accepted
- Date: 2026-08-12
- Decision owners: chrome-cdp-ex maintainers
- Contract target: unpublished v2.15.0 release candidate

## Context

The v2.15 compatibility contract exposes a boolean `mutates` field. It was
originally used for browser-page action feedback, not as a complete security
classification. Several commands that retain `mutates: false` can still change
persisted routing state, dispatch a child command, execute arbitrary JavaScript,
or expose sensitive browser state. A separate hand-maintained MCP confirmation
set had partially compensated for that distinction, but omitted `use`,
`forget`, mutating `tab-group` operations, `loadall`, `record --action`, daemon
keepalive changes, buffer resets, and caller-selected screenshot destinations.

Treating the legacy boolean as the authorization authority would either keep
those gaps open or require an incompatible rewrite of the frozen CLI metadata.

## Decision

Preserve the public `mutates` projection for CLI compatibility, and make the
catalog's explicit `kind` plus `authorization` fields the security authority.
The reviewed policy classes are:

- `read / standard` for ordinary observations;
- `mutation / mutation` for existing action-feedback commands;
- `protected-mutation / mutation` for commands whose legacy boolean is false
  but which change browser or persisted session state;
- `conditional-mutation / conditional` for commands whose arguments decide
  whether they mutate;
- `composite / composite` for bounded workflow commands that dispatch child
  commands;
- `sensitive-read / sensitive-read` for reviewed browser-secret or private
  state reads;
- `script / raw-script` and `raw-cdp / raw-cdp` for escape hatches.

MCP `run_command` confirmation is derived from this catalog policy. Read-only
`tab-group list/show` remains usable without confirmation only after its
arguments are normalized with the same `--format` grammar as the CLI;
ambiguous or repeated format flags fail closed. `tab-group
create/add/remove/delete`, `use`, `forget`, `loadall`, `record --action`,
`keepalive`, `console --clear`, `netlog --clear`, and `diff-shot --reset` now
require `confirm: true`. `shot` and `fullshot` require confirmation only when a
caller chooses an explicit output path; runtime-owned private screenshot paths
remain unprompted. The first-class MCP screenshot tool follows the same rule.
Existing confirmation behavior for other mutation and sensitive-read commands
is preserved. Direct CLI syntax and output do not gain an interactive prompt.

`batch`, `flow`, and `repeat` are explicitly composite even though they are not
currently exposed through the MCP allowlist. `eval`, `eval64`, and `call` are
explicit raw-script policies rather than reads.

## Consequences

- The unpublished v2.15.0 MCP contract fixture gains deterministic denial
  cases for the newly closed confirmation gaps.
- Adding a command or alias cannot silently inherit read authorization from the
  legacy boolean.
- Conditional and composite authorization requires explicit adapter/runtime
  handling; an unknown policy fails closed.
- Public CLI command metadata remains byte/value compatible, while internal
  authorization becomes more precise.

## Rejected alternatives

**Change every legacy `mutates` boolean:** rejected because that field is a
frozen public compatibility projection and also drives action-feedback behavior.

**Keep the independent MCP set:** rejected because two policy owners had
already drifted and left concrete authorization gaps.

**Mark every conditional command as always mutating:** rejected where a bounded
read-only form can be distinguished without ambiguity, such as `tab-group
list/show`.
