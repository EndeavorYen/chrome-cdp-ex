# chrome-cdp-ex Reference

> **TL;DR** — This is the technical reference for `chrome-cdp-ex`: command map, action evidence behavior, browser setup, Electron/WSL2 notes, and benchmark rules. Start with the README when you want the product story.

## Command Map

Most workflows start with `doctor -> list -> open -> perceive -> click/fill -> perceive --since-action -> report`.

| Area | Commands |
|---|---|
| Discovery | `help`, `doctor`, `list`, `open`, `spawn-debug-browser`, `attach`, `use`, `forget`, `current`, `stop`, `closetab`, `keepalive` |
| Perception | `perceive`, `controls`, `summary`, `snap`, `frame`, `overlay`, `text`, `table`, `status`, `console`, `report`, `qa` |
| Visual capture | `shot`, `elshot`, `fullshot`, `scanshot`, `diff-shot` |
| Interaction | `click`, `verify-click`, `jsclick`, `clickxy`, `type`, `press`, `scroll`, `hover`, `fill`, `select`, `upload`, `dialog`, `dismiss-modal` |
| Waiting and flow | `wait`, `waitfor`, `loadall`, `batch`, `flow`, `repeat` |
| Navigation | `nav`, `back`, `forward`, `reload`, `viewport` |
| Inspection | `html`, `eval`, `eval64`, `evalraw`, `call`, `styles`, `net`, `netlog`, `cookies`, `cookieset`, `cookiedel` |
| Live experiment controls | `inject`, `cascade`, `record`, `mock`, `clock`, `throttle` |
| Session assets | `checkpoint`, `restore`, `record-actions`, `export-playwright`, `replay` |

## Agent Loop

The core loop is intentionally short:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node skills/chrome-cdp-ex/scripts/cdp.mjs list
node skills/chrome-cdp-ex/scripts/cdp.mjs open https://example.com
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
node skills/chrome-cdp-ex/scripts/cdp.mjs click <target> @ref
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --since-action
node skills/chrome-cdp-ex/scripts/cdp.mjs report <target>
```

Use `--format json` when another agent or script needs structured handoff data instead of human text.

## Named Targets

Use named aliases when a target prefix is noisy or a workflow should keep addressing the same live tab:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs use <target> --name app
node skills/chrome-cdp-ex/scripts/cdp.mjs current
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive app -C -d 8
node skills/chrome-cdp-ex/scripts/cdp.mjs forget app
```

`attach` is the explicit form for recording a target plus `--port` / `--host`; `use` also accepts `9222/<target>` and stores that CDP port for later commands. `list --format json` includes aliases, and text `list` shows aliases next to matching tabs.

## Semantic Verification And QA

`verify-click` wraps one click with assertions that agents normally check manually:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs verify-click <target> @ref \
  --expect-text "Saved" \
  --expect-request "POST /api/save" \
  --expect-status 200 \
  --no-console-errors \
  --format json
```

It returns `chrome-cdp-ex.semantic-interaction.v1` with the action evidence plus text, network, and console assertions. Text output keeps the same signals readable for human review.

`qa` is a higher-level smoke command for live UI checks:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs qa <target> \
  --desktop 1440x900 \
  --mobile 390x844 \
  --expect-text "Dashboard" \
  --no-console-errors \
  --format json
```

It captures page info, console health, desktop/mobile screenshots, perception summaries, and optional semantic checks. Add `--click <selector-or-ref>` to include a verified interaction before the final assertions.

## Action Evidence

Mutating commands such as `click`, `verify-click`, `qa` with `--click`, `fill`, `type`, `press`, `select`, `scroll`, `upload`, `nav`, `back`, `forward`, `reload`, `viewport`, `inject`, `restore`, and `dismiss-modal` return action evidence.

Action evidence answers three questions:

| Question | Signal |
|---|---|
| Was the action dispatched? | Target, dispatch status, settle status, failure kind when dispatch fails. |
| What changed? | DOM diff summary, bounded evidence sample, console deltas, network deltas. |
| What should the agent do next? | `outcome`, `verdict`, `recommendation`, `nextSteps`, and recovery commands. |

### Action Receipt

`chrome-cdp-ex.action.v1` keeps the full low-level evidence envelope. Each action also includes `receipt.schema = chrome-cdp-ex.action-receipt.v1`, a stable summary contract for agents that should not have to infer progress from prose. CLI JSON and report handoffs keep the receipt compact by omitting duplicated fields and unchanged delta channels; the per-target JSONL session log preserves the full receipt for audit and replay correlation.

| Receipt field | Meaning |
|---|---|
| `actionId` | Stable pre-log correlation hash for the attempted action. |
| `eventId` / `sequence` / `loggedAt` | Session-level event identity added when the action is recorded; use this for audit, report, and replay correlation. |
| `actionName` / `targetSummary` | What was attempted and the resolved target label; duplicated in compact handoffs as top-level `action` and `target`. |
| `dispatch` | Whether the input command reached CDP or failed before dispatch. |
| `settlement` | Whether post-action observation settled, which strategy was used, how long it took, and why the agent can or cannot trust the post-action evidence. |
| `outcome` | Normalized result: `changed`, `no-change`, `attention`, `failed`, `timeout`, or `dispatched`. |
| `observedDelta` | Bounded human-readable evidence lines: DOM diff, console, exceptions, network, or observation error. Compact handoffs keep signal-bearing lines. |
| `observedDeltaDetails` | Structured delta rows such as `{ type, status, count, sample }` for DOM, console, exceptions, network, dispatch, and observation errors. Compact handoffs keep changed, failed, no-change, not-captured, and non-zero channels. |
| `blockingSignals` | Structured blockers such as stale refs, observation errors, or no-change investigation signals. |
| `recoveryHint` | One-line explanation of what the agent should do before retrying or continuing. |
| `nextSteps` | Executable `cdp ...` commands for the next observation, report, or recovery action. |
| `recovery` | Strategy, priority, and verify command when the action needs recovery; compact handoffs expose the same path through top-level `recommendation`, `verdict`, and `nextSteps`. |

Settlement fields:

| Settlement field | Meaning |
|---|---|
| `ok` | Backward-compatible boolean from the action feedback loop. |
| `state` | `settled`, `not-confirmed`, `not-applicable`, or `failed`. |
| `strategy` | `dom-observation`, `timeout`, `observation-error`, `dispatch-failed`, or `report-only`. |
| `durationMs` / `timeoutMs` | Elapsed action feedback time and, when known, the timeout budget. |
| `observedChannels` | Full/action JSON channels captured for this action, such as `ax-diff`, `console`, `exceptions`, `network`, `dispatch`, or `observation`. |
| `signals` | Machine-readable settlement signals such as `settlement-timeout`, `observation-error`, `dispatch-failed`, or `report-only`. |
| `reason` | Short explanation of the settlement state; compact action handoffs may omit the redundant `settled` explanation while preserving reasons for failed or not-confirmed states. |

Receipt surfaces:

| Surface | Purpose | Receipt shape |
|---|---|---|
| Session JSONL / action log | Audit, replay, and debugging | Full receipt, including recovery metadata and unchanged delta channels. |
| Action JSON | Agent handoff immediately after one command | Compact receipt with dispatch, settlement semantics, signal-bearing deltas, recovery hint, and executable next steps. |
| Report JSON | Session handoff | Smaller receipt with event identity, settlement summary, outcome, blocking signals, recovery hint, and compact delta details. |
| Text output | Human quick read | Outcome, receipt status, blocking signals, recovery hint, settle line, and high-signal evidence samples. |

Common outcomes:

| Outcome | Meaning |
|---|---|
| `changed` | The page changed and the agent can usually continue. |
| `no-change` | The action dispatched but did not produce visible change; inspect overlay/frame/state before retrying. |
| `attention` | Console, network, or observation signals need diagnosis. |
| `failed` | Dispatch failed; use the recovery command. |
| `timeout` | The action may have happened, but post-action observation timed out. |

For `no-change`, the receipt exposes target-aware blocking signals. Click/fill-style actions get `overlay-check-needed`; frame-scoped targets such as `@f2:4` get `frame-check-needed`; every no-change action gets `fresh-perception-needed`. Treat these as "inspect before retry" signals and follow the matching `nextSteps`.

If dispatch succeeds but post-action observation fails internally, the action still returns `chrome-cdp-ex.action.v1` with an `observation-error` diagnosis instead of a generic CLI error.

`perceive --since-action` replays the causal diff from the last mutating command. `report --format json` packages the latest action, diagnosis, artifacts, recommendation, and timeline window.

## Daemon Freshness

Target commands check per-tab daemon metadata before dispatching work. If an existing daemon was started from an older checkout, or cannot report metadata, the CLI returns a `stale-daemon` recovery model with `cdp stop <target>` and `rerun the original command` in `nextSteps`. Use `--allow-stale-daemon` only for intentional long-running daemon sessions.

## CSS Source Tracing

Use `cascade` when the agent knows what looks wrong but needs the source rule:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs cascade <target> @ref background-color --format json
```

`cascade` returns the winning selector, overridden rules, source location, and edit target. It also resolves common Vite, CSS Modules, and Vue source-map locations.

## Session Assets

Use these when exploration should become reusable evidence:

| Need | Command |
|---|---|
| Save browser state with redacted values | `checkpoint <target> --format json` |
| Save a fully restorable secret checkpoint | `checkpoint <target> --unsafe-full --format json` |
| Restore captured URL/storage/cookies | `restore <target> --file checkpoint.json --format json` |
| Export the action log | `record-actions <target> --format json` |
| Draft a Playwright spec | `export-playwright <target> --format json` |
| Replay portable live steps | `replay <target> --file artifact.json --format json` |
| Capture visual fallback diffs | `diff-shot <target>` |

Report, record-actions, export-playwright, and session JSONL artifacts redact common password, token, API key, authorization, cookie, and session patterns by default while preserving command names, keys, counts, domains, and paths for debugging. Checkpoint JSON also redacts cookie values and sensitive storage keys by default. Use `checkpoint --unsafe-full --format json` only when you need a fully restorable artifact; that output intentionally includes raw cookies and storage values, so treat it like a secret.

## Browser Setup

Preferred path: use the browser you already have open, then enable remote debugging from `chrome://inspect/#remote-debugging` or `edge://inspect`.

When that is not available, spawn an isolated debug profile:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser edge --port 9222 --url https://example.com
node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser chrome --headless --no-sandbox --port 9222 --url https://example.com
```

Configuration:

| Variable | Purpose |
|---|---|
| `CDP_PORT` | Connect to a specific debugging port. |
| `CDP_HOST` | Override the CDP host, default `127.0.0.1`. |
| `CDP_PORT_FILE` | Override the `DevToolsActivePort` file path. |

`spawn-debug-browser` waits until `/json/version` answers before reporting success. If the browser exits early or CDP never becomes ready, the error includes captured stdout/stderr and a recovery command. `doctor` includes an `Environment` check and recommends `--headless --no-sandbox --exe <path>` when it detects Linux CI, containers, SSH-style remote shells, or no display.

## MCP Server

For agent-native workflows, run the stdio MCP adapter:

```bash
node skills/chrome-cdp-ex/scripts/mcp-server.mjs
```

It exposes tools for `doctor`, `list_tabs`, `open_or_attach`, `perceive`, `controls`, `overlay`, `screenshot`, `click`, `verify_click`, `dismiss_modal`, `fill`, `viewport`, `qa_page`, and `report`. Mutating tools require `confirm: true`, and the adapter maps each call to the same `cdp.mjs` commands documented above.

Use the MCP benchmark when changing the adapter or tool surface:

```bash
npm run benchmark:mcp
```

The benchmark exercises the live problem-finding path through stdio MCP: open a smoke page, discover compact visible controls, detect a blocking modal, recover with `dismiss_modal`, validate a combat action with `verify_click`, and hand off the action timeline with `report`.

## Electron

Start Electron with remote debugging enabled:

```bash
electron . --remote-debugging-port=9222
CDP_PORT=9222 node skills/chrome-cdp-ex/scripts/cdp.mjs list
```

In dev builds, you can enable it from the main process:

```js
if (process.env.NODE_ENV === 'development') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}
```

## WSL2 To Windows

For WSL2 controlling Windows Chrome, run Windows-side Node so CDP connects to Windows localhost:

```bash
powershell.exe -NoProfile -Command "(Get-Command node -ErrorAction SilentlyContinue).Source"
"/mnt/c/.../node.exe" skills/chrome-cdp-ex/scripts/cdp.mjs list
```

## Benchmark Gate

The dogfood benchmark launches a disposable debug browser and measures:

- `doctor -> open -> perceive -> act -> since-action evidence -> report`
- command calls, total time, first useful observation, useful observation tokens
- action evidence coverage and JSON completeness
- Action Receipt contract completeness
- failed-action diagnosis and no-change recovery
- `nextSteps` and recommendation handoffs
- modal, frame, CSS tracing, HMR/SPA diff, stale-ref recovery, and session stability probes

Run:

```bash
npm run benchmark:killer
npm run benchmark:killer -- --json
npm run benchmark:generic-cdp -- --out generic-cdp-raw.json
npm run benchmark:playwright -- --out playwright-raw.json
npm run benchmark:baseline -- playwright-raw.json generic-cdp-raw.json --out baselines.json
npm run benchmark:killer -- --comparison-baselines ./baselines.json
npm run benchmark:campaign -- --rounds 10 --output ./campaign.json
npm run benchmark:campaign -- --rounds 10 --history ./campaign-history.jsonl
npm run benchmark:campaign -- --types large-app --rounds 1 --json
```

Use [`docs/benchmarks/measured-baselines.example.json`](benchmarks/measured-baselines.example.json) as the checked-in schema fixture for reviewers. Do not publish comparison claims from that example file; regenerate a measured `baselines.json` for the machine and browser under test.

Use `benchmark:campaign` for repeated live testing. It runs sequential rounds with unique CDP and HTTP ports, alternating MCP and Killer Path by default, then reports pass rate, latency, estimated output tokens, first-useful-observation time, and the slowest / largest-output step candidates. Add `--types large-app` to run the high-intensity live SaaS stress fixture with 5000+ DOM nodes, 1000 source table rows, 200+ visible controls, bounded output checks, and truncation metadata coverage.

Add `--history <jsonl>` when running self-improvement loops. The campaign appends a compact record for each run and reports deltas against the previous record for pass rate, average output tokens, max step tokens, and slowest-step latency so regressions are visible before opening or merging follow-up fixes.

When a campaign round fails, the summary includes issue-ready diagnostics with a suggested title, reproduction command, ports, failed criteria, culprit step, artifact paths, and labels. Use those drafts as the starting point for follow-up issues instead of hand-writing failure reports from raw logs.

For the repeatable issue -> fix -> review -> merge process, use the [self-improvement loop runbook](self-improvement-loop.md).

Direct live benchmark commands use a shared lock and fail fast if another live benchmark is already running. Prefer `benchmark:campaign` instead of launching `benchmark:mcp`, `benchmark:killer`, or large-app stress runs in parallel; the campaign runner keeps the lock for the full sequence and avoids cross-run CDP target contamination.

Publish comparison claims only when `gate.passed` is true and competitor baselines are measured, not the planning-only `heuristic-smoke-baseline`.

## More Detail

The canonical exhaustive reference is [skills/chrome-cdp-ex/SKILL.md](../skills/chrome-cdp-ex/SKILL.md). Keep this page readable; put command-by-command edge cases there.
