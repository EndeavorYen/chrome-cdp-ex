# Agent Browser Vision Strategy

## Thesis

Playwright is the deterministic test runner. `chrome-cdp-ex` is the live-page perception and control layer for agents.

## Differentiators

- Real logged-in browser sessions.
- One-call page perception.
- Layout, style, coordinate, console, and ref awareness in compact output.
- CSS source tracing through `cascade`.
- Action feedback that reports effects, not only dispatch success.
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
- Stale-ref recovery rate.
- Time to identify CSS source.
- Success rate on real logged-in apps.
- Success rate on iframe/modal/HMR-heavy apps.
