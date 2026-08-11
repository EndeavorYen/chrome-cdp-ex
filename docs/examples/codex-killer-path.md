# Codex Killer Path

This is the reproducible validation route for using `chrome-cdp-ex` as a Codex skill. The machine-readable status is [host-validation.v1.json](../benchmarks/host-validation.v1.json); treat that manifest as the authority on whether the route is documented, smoke-tested, or live-validated.

## Validation boundary

| Field | Value |
|---|---|
| Product | `chrome-cdp-ex` v2.14.0 |
| Host | Codex |
| Route | CLI skill |
| Validation date | 2026-08-12 |
| Browser scope | Disposable local fixture |
| Personal browser state | Not accessed |

`Validated with Codex` means this Codex session completed installation/setup, live perception, a mutation with an Action Receipt, causal follow-up perception, and report handoff against the safe fixture. It does not mean a native Codex plugin exists, every Codex surface was tested, or a personal logged-in page was recorded.

## 1. Install the skill without changing a personal Codex home

For the published install, copy the skill to the normal Codex path:

```bash
mkdir -p ~/.codex/skills
cp -R skills/chrome-cdp-ex ~/.codex/skills/
node scripts/setup.mjs --for codex
```

For release validation, use a disposable home and invoke the copied runtime from there:

```bash
validation_home="$(mktemp -d)"
mkdir -p "$validation_home/.codex/skills"
cp -R skills/chrome-cdp-ex "$validation_home/.codex/skills/"
node "$validation_home/.codex/skills/chrome-cdp-ex/scripts/cdp.mjs" doctor --format json
```

The disposable path proves the packaged skill is self-contained without overwriting an existing `~/.codex/skills/chrome-cdp-ex` install.

## 2. Verify setup and the agent-native socket

```bash
node scripts/setup.mjs --for codex
node scripts/setup.mjs --verify
```

`--verify` returns `chrome-cdp-ex.setup-verify.v1`, runs `doctor --format json`, and completes an MCP initialize smoke. Browser readiness can remain advisory until the disposable debug browser starts.

## 3. Run the live evidence loop

Use a safe local fixture or the benchmark's disposable debug browser. Once `list` returns a target, keep the same target through the causal loop:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs list --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8 --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs click <target> @ref --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --since-action --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs report <target> --compact --format json
```

For forms, replace the action line with:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs fill <target> @ref "Codex validation" --format json
```

## 4. Evidence required for `live-validated`

| Step | Required evidence |
|---|---|
| Install | Runtime executes from the copied disposable skill directory |
| Doctor | Structured readiness result and recovery guidance |
| Perceive | Visible controls/layout and stable target references |
| Act | Mutation dispatches against the safe fixture |
| Action Receipt | `receipt.schema = chrome-cdp-ex.action-receipt.v1` with settlement and observed delta |
| Causal follow-up | `perceive --since-action` explains what changed after the action |
| Report | Structured session timeline suitable for agent handoff |

The checked-in host manifest may use `live-validated` only when all seven capability fields are true and its evidence paths resolve.

### Observed v2.14.0 result (2026-08-12)

The copied disposable Codex skill completed the full loop against `scripts/smoke-page.html` in an isolated headless Edge profile:

| Evidence | Observed result |
|---|---|
| Doctor | `chrome-cdp-ex.doctor.v1`; `operationalReady: true` |
| Perceive | `chrome-cdp-ex.perceive.v1`; 10 interactive refs, zero console errors |
| Act + receipt | `fill #cmd "look trainer"` returned `chrome-cdp-ex.action.v1`, `outcome.status: changed`, and `chrome-cdp-ex.action-receipt.v1` |
| Recovery semantics | A subsequent blocked click returned `outcome.status: no-change` with executable overlay, fresh-perception, and report steps |
| Causal follow-up | `chrome-cdp-ex.perceive-diff.v1` in `since-action` mode |
| Report | `chrome-cdp-ex.report.v1`; two actions in the compact timeline |

This is host-route evidence from one Codex session and one safe local fixture. It is not evidence that the other five documented hosts were live-tested, and it is not an adoption count.

## 5. Current release gate

The host route is complemented by the ten-round mixed campaign:

```bash
npm run benchmark:campaign -- --rounds 10 --types mcp,cli,killer,large-app,real-app,real-app,real-app,real-app,real-app,cli --real-app-targets dashboard,docs-app,auth-flow,data-table,canvas-heavy --settle-ms 0 --json --output /tmp/chrome-cdp-ex-phase0/release-campaign-v2.14.0.json
```

The campaign and the Codex host route prove different things: the campaign gates runtime quality across multiple paths and fixtures; the host record proves how Codex reaches that runtime. Neither substitutes for independent user adoption.

Observed v2.14.0 campaign result on 2026-08-12: **10/10 rounds passed**, including **5/5 real-app profiles** with **34/34 checks in each real-app round**. The raw campaign artifact is intentionally local-only because it contains machine-local timing and target identifiers.
