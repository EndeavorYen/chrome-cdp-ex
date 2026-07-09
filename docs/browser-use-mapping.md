# Browser Use Mapping

This document maps **chrome-cdp-ex** agent handoffs to language used by Browser Use–style browser agents. It is a contribution and interoperability note — not a runtime dependency, and not a claim that either project implements the other.

## Why this mapping exists

Both projects care about:

1. Doing something in a live page
2. Knowing whether the action actually changed state
3. Recovering when the page fights the agent (overlay, stale refs, navigation)
4. Handing evidence to the next step without dumping an entire DOM

chrome-cdp-ex optimizes for **connecting to the user’s already-running browser**. Browser Use optimizes for **agent loops that drive browser actions**. The vocabulary below helps contributors translate proofs and recovery policies across that boundary.

## Core concept map

| chrome-cdp-ex | Browser Use–style concept | Notes |
|---|---|---|
| `chrome-cdp-ex.action.v1` | Action result / step result | Full evidence envelope after a mutating command |
| `chrome-cdp-ex.action-receipt.v1` | Compact action receipt | Dispatch + settlement + outcome without full DOM dump |
| `outcome` (`changed`, `no-change`, `failed`, `timeout`, …) | Task progress signal | Separates “command sent” from “UI changed” |
| `settlement.state` / `strategy` / `signals` | Wait / settle semantics | Whether the page quieted after dispatch |
| `blockingSignals` | Blocker flags | e.g. overlay, wrong frame, fresh perception needed |
| `recommendation` + `nextSteps` | Recovery / next action plan | Executable CLI/MCP commands for the next turn |
| `chrome-cdp-ex.action-diagnosis.v1` | Failure classification | overlay, stale-ref, network-failure, timeout, … |
| `chrome-cdp-ex.recovery-policy.v1` | Recovery policy | Strategy, priority, verify command, avoid list |
| `perceive` / `perceive --since-action` | Observe / diff observation | Pre- and post-action page understanding |
| `report` / `record-actions` | Session memory / trajectory | Timeline for handoff, replay, and export |
| `doctor` readiness | Environment readiness | `ready` / `usable-with-warnings` / `blocked` |
| Benchmark gate | Promotion / eval gate | Live proofs before adoption claims |

## Action Receipt ↔ step result

A typical chrome-cdp-ex mutating command returns:

- **dispatch** — did CDP/input delivery succeed?
- **settlement** — did the page quiet / load / respond within policy?
- **outcome** — did we observe a meaningful change?
- **receipt** — compact, stable summary for prompts
- **recommendation / nextSteps** — what to run next

Browser Use–style agents usually fold the same ideas into “action result + extracted state + error”. When porting:

1. Map `dispatch.ok=false` to a hard action error.
2. Map `outcome=no-change` to a soft failure that should trigger recovery, not success.
3. Prefer `receipt` fields in prompts; keep full action JSON for debugging only.

## Recovery policy registry

chrome-cdp-ex centralizes diagnosis kinds in `RECOVERY_POLICY_REGISTRY` (`skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs`).

| Kind | Strategy | Typical next command |
|---|---|---|
| `overlay` | `clear-overlay` | `dismiss-modal`, then `perceive` |
| `stale-ref` / `dom-rewrite` / `navigation` | `refresh-perception` | `perceive -C -d 8` |
| `wrong-frame` | `refresh-frame-context` | `frame`, then frame-scoped `perceive` |
| `network-failure` | `inspect-network` | `netlog`, `perceive --since-action` |
| `console-error` / `exception` | `inspect-runtime-errors` | `console --errors` |
| `timeout` / observation issues | `check-tab-health` | `status`, then since-action |

Browser Use recovery handlers can mirror these strategies without sharing code: same kind names, same ordered next steps, different runtime APIs.

## No-change is not success

When an action dispatches but the AX tree does not change, chrome-cdp-ex emits:

- `outcome: no-change`
- blocking signals such as `overlay-check-needed`, `frame-check-needed`, `fresh-perception-needed`
- an investigate-style recommendation

Agents should treat this as **needs recovery**, not as a successful task step. That is the same failure mode Browser Use loops hit when click handlers are blocked or the wrong frame is targeted.

## Benchmark and promotion gate

chrome-cdp-ex refuses promotion-style claims when live gates fail. The gate checks:

- action evidence coverage
- Action Receipt completeness
- recovery command coverage
- bounded report/token budgets
- differentiator probes (overlay, frames, cascade, HMR/SPA)

A Browser Use integration or comparison should publish the same honesty rule: **no adoption claim without a live proof path**.

## Suggested contribution language

When proposing cross-project work:

1. **Share schemas, not runtimes** — Action Receipt and recovery policy shapes are portable.
2. **Keep live-session attach optional** — Browser Use can keep launching browsers; chrome-cdp-ex can keep attaching.
3. **Normalize recovery kinds** — overlay / stale locator / navigation / network are universal.
4. **Benchmark with real pages** — smoke fixtures plus adversarial traits beat toy demos.

## Related local docs

- [Technical reference](reference.md)
- [Agent browser vision strategy](strategy/agent-browser-vision.md)
- [Self-improvement loop](self-improvement-loop.md)
- Action recovery implementation: `skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs`
