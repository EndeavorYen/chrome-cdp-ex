# Agent Browser Vision Strategy

## Thesis

Playwright is the deterministic test runner. `chrome-cdp-ex` is the live-page perception and control layer for agents.

## Differentiators

- Real logged-in browser sessions.
- One-call page perception.
- Layout, style, coordinate, console, and ref awareness in compact output.
- CSS source tracing through `cascade`.
- Action Receipts that report dispatch, settlement, observed delta, blocking signals, and recovery hints instead of only dispatch success.
- Electron, WSL2, and long-session ergonomics.
- Zero runtime dependencies and single-file distribution.

## Core Workflows

1. Inspect logged-in dashboard.
2. Identify broken UI state.
3. Trace CSS source.
4. Prototype CSS fix with `inject`.
5. Fill form and verify effect.
6. Close modal safely.
7. Debug console/network failure.
8. Record cause/effect after action.
9. Export deterministic Playwright test from observed flow.

## Metrics

- Calls to understand page.
- Tokens per useful observation.
- Action success with no extra verification call.
- Action Receipt completeness rate.
- Stale-ref recovery rate.
- Time to identify CSS source.
- Success rate on real logged-in apps.
- Success rate on iframe/modal/HMR-heavy apps.

## Agent Observability Contracts

The product direction is to make browser work auditable at each handoff boundary:

| Contract | Purpose |
|---|---|
| Perception | Compact `perceive`/`summary` models that expose visible targets, refs, layout, console health, and budget metadata. |
| Action Receipt | `chrome-cdp-ex.action-receipt.v1` summarizes dispatch, settlement, observed delta, structured delta details, session event identity, blocking signals, recovery hint, and next steps. |
| Receipt Surfaces | Full session logs, action JSON, report JSON, and text output each expose the receipt shape appropriate for audit, agent handoff, session handoff, or quick human reading. |
| Recovery Policy | Failed, timed-out, stale-ref, wrong-frame, overlay, and no-change paths should expose executable recovery commands before the agent retries. |
| Session Handoff | `report`, `record-actions`, `replay`, and `export-playwright` preserve what happened, what is portable, and what needs review. |
| Benchmark Gate | Promotion claims are blocked unless live browser runs prove evidence coverage, receipt completeness, recovery coverage, and bounded output. |

## Improvement Plan

| Area | Plan | Why |
|---|---|---|
| Action Receipt v1 | Shipped as a derived field inside `chrome-cdp-ex.action.v1`, with structured delta details and session event ids when recorded. | Gives agents a stable receipt instead of asking them to parse low-level evidence every time. |
| Settlement semantics | Shipped explicit `settlement.state`, `strategy`, `signals`, and `reason` fields in Action Receipt v1. | Separates dispatch success from page/app processing evidence so agents do not over-trust weak settlement. |
| Receipt surface contract | Shipped centralized action/report receipt surface helpers while preserving full session log receipts. | Keeps prompt-facing handoffs compact as new evidence fields are added. |
| No-change recovery | Shipped target-aware `overlay-check-needed`, `frame-check-needed`, and `fresh-perception-needed` signals. | Prevents "dispatch succeeded" from being mistaken for task progress without forcing irrelevant frame checks. |
| Adaptive perception budget | Make `perceive` choose line/token budget from page density, error state, and task context. | Keeps output small without hiding the next useful target. |
| Recovery policy registry | Centralize diagnosis -> strategy -> commands so action, report, replay, and benchmark agree. | Reduces drift between text, JSON, and tests. |
| Component inspection | Add React/Vue component tree and state inspection when framework hooks are available. | Bridges DOM perception and source-level UI debugging. |
| Multi-tab coordination | Add `tab-group` / `broadcast` for workflows crossing OAuth, admin/customer tabs, or popup windows. | Real user tasks often span more than one page target. |
| Browser Use mapping | Publish a comparison/mapping document from Action Receipt concepts to Browser Use's action-result and recovery model. | Creates a concrete upstream contribution path without forcing either project to adopt the other's runtime. |
