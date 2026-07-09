# chrome-cdp-ex Reference

> **TL;DR** — This is the technical reference for `chrome-cdp-ex`: command map, action evidence behavior, browser setup, Electron/WSL2 notes, and benchmark rules. Start with the README when you want the product story.

## Command Map

Most workflows start with `doctor -> list -> open -> perceive -> click/fill -> perceive --since-action -> report`.

| Area | Commands |
|---|---|
| Discovery | `help`, `doctor`, `list`, `target`, `tab-group`, `broadcast`, `open`, `spawn-debug-browser`, `attach`, `use`, `forget`, `current`, `stop`, `closetab`, `keepalive` |
| Perception | `perceive`, `controls`, `summary`, `snap`, `frame`, `overlay`, `text`, `table`, `components`, `status`, `console`, `report`, `qa`, `responsive-audit` |
| Visual capture | `shot`, `elshot`, `fullshot`, `scanshot`, `diff-shot` |
| Interaction | `click`, `verify-click`, `jsclick`, `clickxy`, `type`, `press`, `scroll`, `hover`, `fill`, `select`, `upload`, `dialog`, `dismiss-modal` |
| Waiting and flow | `wait`, `waitfor`, `loadall`, `batch`, `flow`, `repeat` |
| Navigation | `nav`, `back`, `forward`, `reload`, `viewport`, `emulate` |
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

For large pages, `perceive --adaptive` (or `perceive --last auto`) chooses a text-row budget from page density and console errors. Explicit `--last N` always wins.

## Install And Release Surface

Official releases live on GitHub, not the npm registry. Use the release tag, release notes, GitHub Pages proof page, and attached tarball as the publish surface.

Pinned v2.10.0 install:

```bash
curl -L -o pi-chrome-cdp-2.10.0.tgz https://github.com/EndeavorYen/chrome-cdp-ex/releases/download/v2.10.0/pi-chrome-cdp-2.10.0.tgz
mkdir -p chrome-cdp-ex-v2.10.0
tar -xzf pi-chrome-cdp-2.10.0.tgz -C chrome-cdp-ex-v2.10.0 --strip-components=1
cd chrome-cdp-ex-v2.10.0
claude --plugin-dir .
```

The GitHub Release notes publish the final tarball checksum after package validation.

For current `main`, clone `https://github.com/EndeavorYen/chrome-cdp-ex.git` and use the same `claude --plugin-dir .` or `cp -r skills/chrome-cdp-ex ~/.claude/skills/` path documented in the README.

## Named Targets

Use named aliases when a target prefix is noisy or a workflow should keep addressing the same live tab:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs use <target> --name app
node skills/chrome-cdp-ex/scripts/cdp.mjs current
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive app -C -d 8
node skills/chrome-cdp-ex/scripts/cdp.mjs forget app
```

`attach` is the explicit form for recording a target plus `--port` / `--host`; `use` also accepts `9222/<target>` and stores that CDP port for later commands. `list --format json` includes aliases, and text `list` shows aliases next to matching tabs.

When many tabs are open, select by URL/title instead of guessing prefixes:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs target --url http://127.0.0.1:8788 --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs target --title "Agent Decision Lab"
node skills/chrome-cdp-ex/scripts/cdp.mjs open http://127.0.0.1:8788 --reuse-url
```

`list` ranks non-blank pages first and marks the recommended target. Ambiguous `target` matches return candidate URLs/titles plus exact follow-up commands.

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

For responsive regression checks, use `responsive-audit` (alias `visual-check`):

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs responsive-audit <target> --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs visual-check <target> --viewport 1440x900 --viewport 390x844 --out-dir /tmp/cdp-audit
```

It walks a bounded set of viewports (default desktop + mobile), captures screenshots outside the repo by default (session screenshot dir or explicit `--out-dir`), and reports overflow-x, blank-page, console, control counts, and a pass/warn/fail summary.

Compact QA handoffs are also available on common commands:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --qa --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs click <target> @ref --qa
node skills/chrome-cdp-ex/scripts/cdp.mjs report <target> --qa --format json
```

MCP tools mirror these workflows: `select_target`, `responsive_audit`, plus `qa` flags on `perceive` / `click` / `report`, and `open_or_attach.reuseUrl`.

See also [Browser Use mapping](browser-use-mapping.md) and [awesome-list outreach research](outreach/awesome-lists.md).

## Multi-tab groups

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs tab-group create auth AABB CC11
node skills/chrome-cdp-ex/scripts/cdp.mjs broadcast auth perceive -C -d 4
node skills/chrome-cdp-ex/scripts/cdp.mjs tab-group show auth --format json
```

Groups are stored in the CDP runtime directory (not the git repo). Prefer read-only broadcast commands unless mutation is intentional.

## Components (MVP)

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs components <target> --depth 4
node skills/chrome-cdp-ex/scripts/cdp.mjs components <target> @3 --format json
```

Works best with React/Vue dev builds or DevTools hooks. Production minification may strip component names.

## Media emulation

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs emulate <target> dark
node skills/chrome-cdp-ex/scripts/cdp.mjs emulate <target> reduced-motion reduce
node skills/chrome-cdp-ex/scripts/cdp.mjs emulate <target> off --format json
```

`emulate` sets CDP media features (`prefers-color-scheme`, `prefers-reduced-motion`) for dark-mode and motion QA without raw DevTools calls.

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

For token-bound handoffs, add `--compact` to mutating action JSON and report JSON:

```bash
cdp click <target> @1 --format json --compact
cdp report <target> --last 1 --format json --compact
```

Compact action/report JSON keeps the executable handoff contract - `schema`, target/action identity, dispatch/settlement status, high-signal evidence, outcome/verdict, recommendation, next steps, and receipt recovery data - while trimming duplicated full diagnostic envelopes and long DOM evidence. Use the session JSONL path from `report` when you need the full audit trail.

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
npm run benchmark:killer -- --json --adversarial-seed round5-alpha
npm run benchmark:campaign -- --rounds 10 --output ./campaign.json
npm run benchmark:campaign -- --rounds 3 --types killer --adversarial-seeds alpha,beta --json
npm run benchmark:campaign -- --rounds 10 --history ./campaign-history.jsonl
npm run benchmark:campaign -- --rounds 10 --compare-baseline ./main-campaign.json
npm run benchmark:campaign -- --types large-app --rounds 1 --json
npm run benchmark:campaign -- --types real-app --real-app-targets dashboard,docs-app,auth-flow --rounds 3 --json
```

Use [`docs/benchmarks/measured-baselines.example.json`](benchmarks/measured-baselines.example.json) as the checked-in schema fixture for reviewers. Do not publish comparison claims from that example file; regenerate a measured `baselines.json` for the machine and browser under test.

Use `benchmark:campaign` for repeated live testing. It runs sequential rounds with unique CDP and HTTP ports, alternating MCP and Killer Path by default, then reports pass rate, latency, estimated output tokens, first-useful-observation time, and the slowest / largest-output step candidates. Add `--types large-app` to run the high-intensity live SaaS stress fixture with 5000+ DOM nodes, 1000 source table rows, 200+ visible controls, bounded output checks, and truncation metadata coverage.

Add `--types real-app --real-app-targets dashboard,docs-app,auth-flow` when you need local target classes that behave more like real products. Built-in target profiles are `dashboard`, `docs-app`, `auth-flow`, `data-table`, and `canvas-heavy`; campaign output records `realAppTarget`, `targetClass`, and culprit steps for failures or optimization suspects. These profiles are safe local/test-only fixtures. If you point future target profiles at external URLs, use only owned test tenants or explicit staging environments, never customer data, personal accounts, or production workflows.

The README and GitHub Pages benchmark proof should use a current real-app campaign when making high-difficulty usability claims. For the v2.10.0 front-door snapshot, the campaign command was:

```bash
npm run benchmark:campaign -- --rounds 3 --types real-app --real-app-targets dashboard,docs-app,auth-flow --settle-ms 0 --json --output real-app-campaign.json
```

Killer Path gates include long-session report budget coverage. Any report handoff with 50 or more recorded actions must stay inside its JSON byte budget, expose `latestAction`, keep a bounded non-expensive `timelineWindow`, preserve recovery-critical receipt fields, and point to artifact paths instead of dumping all history.

Campaign summaries include a `routeRecommendation` block. When comparable MCP and CLI rounds are present, it compares pass rate, average total latency, first-useful-observation latency, first-action-evidence latency, and estimated output tokens, then returns `mcp`, `cli`, or `inconclusive` with a confidence level. Deltas are reported as `mcp - cli`; negative latency or token deltas mean MCP used less. Adversarial CLI rounds are excluded from route recommendations so replay stress does not pollute matched-route decisions.

Use `--adversarial-seed <seed>` on `benchmark:killer` when you need a replayable high-difficulty browser page. The generated page composes overlay, stale-ref, iframe, shadow DOM, SPA route, slow-network, auth-wall, large-table, and hidden-template traits while preserving the normal Killer Path selectors. Campaigns can pass `--adversarial-seeds alpha,beta`; failing rounds include the seed and reproduction command in `issueDrafts`.

Add `--history <jsonl>` when running self-improvement loops. The campaign appends a compact record for each run and reports deltas against the previous record for pass rate, average output tokens, max step tokens, and slowest-step latency so regressions are visible before opening or merging follow-up fixes.

Add `--compare-baseline <json-or-jsonl>` during PR review when you need a before-after regression check against `main` or a saved campaign summary. The comparison reports pass-rate delta, average output-token delta, max-step token delta, slowest-step latency delta, and new culprit changes for both slowest and largest-output steps. JSONL baselines use the latest non-empty record, so a `--history` file can double as a compact review baseline.

When a campaign round fails, the summary includes issue-ready diagnostics with a suggested title, reproduction command, ports, failed criteria, culprit step, artifact paths, and labels. Use those drafts as the starting point for follow-up issues instead of hand-writing failure reports from raw logs.

For the repeatable issue -> fix -> review -> merge process, use the [self-improvement loop runbook](self-improvement-loop.md).

Direct live benchmark commands use an isolated run manager and fail fast if the configured live slot is already owned. Each owner record includes the benchmark name, run id, slot, CDP port, HTTP server port, profile directory, process id, and heartbeat timestamp, so interrupted runs can be reclaimed without hiding live owners. Prefer `benchmark:campaign` for repeated testing; it keeps one owner for the full sequence while allocating unique round ports to avoid cross-run CDP target contamination.

Publish comparison claims only when `gate.passed` is true and competitor baselines are measured, not the planning-only `heuristic-smoke-baseline`.

## More Detail

The canonical exhaustive reference is [skills/chrome-cdp-ex/SKILL.md](../skills/chrome-cdp-ex/SKILL.md). Keep this page readable; put command-by-command edge cases there.
