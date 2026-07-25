# chrome-cdp-ex

[![81 Commands](https://img.shields.io/badge/commands-81-orange)](skills/chrome-cdp-ex/scripts/cdp.mjs)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)](skills/chrome-cdp-ex/scripts/cdp.mjs)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)
[![Release v2.14.0](https://img.shields.io/badge/release-v2.14.0-brightgreen)](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.14.0)
[![MIT License](https://img.shields.io/badge/license-MIT-gray)](LICENSE)

> **TL;DR** — Give coding agents eyes and hands on your **already open** Chrome / Edge / Electron session: perceive layout, act with Action Receipts, recover from overlays and stale refs, then hand off a session report.

Playwright is excellent for deterministic tests in a clean browser. `chrome-cdp-ex` is for **live-page perception** when the agent needs the browser you are actually using — cookies, login state, and open tabs included.

## What's new in v2.14.0

| Area | Change |
|---|---|
| Cross-host install | `scripts/setup.mjs` + [INTEGRATIONS.md](INTEGRATIONS.md) for Claude Code, Codex, Cursor, OpenClaw, Hermes, Pi |
| Slim skill | Always-loaded golden path; deep docs in `references/` |
| MCP | Curated Tier-1 tools, allowlisted `run_command`, session resources |
| Release asset | Tarball includes plugin manifest, `bin/chrome-cdp`, and `setup.mjs` |

[Release notes →](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.14.0)

## Why agents need this

| Pain | What this gives the agent |
|---|---|
| "I can click, but I cannot really see the page." | Layout, visible text, colors, coordinates, refs, console health |
| "I clicked. Did anything happen?" | Action Receipt: dispatch, settlement, delta, blockers, next steps |
| "Which CSS rule made this button blue?" | `cascade` traces style back to selector and source line |
| "The bug only happens in my logged-in browser." | Real Chrome / Edge / Brave / Electron / WSL2→Windows sessions |
| "Exploration disappears after one prompt." | Reports, checkpoints, replay, Playwright export |

## Proof

[![Last measured Smart Eye campaign (v2.12.0): 10/10 rounds, 34/34 quality gate](experiment/benchmark-proof.png)](https://endeavoryen.github.io/chrome-cdp-ex/experiment/benchmark.html)

[![Redesign experiment: richer perception produced the better page](experiment/final-A.png)](https://endeavoryen.github.io/chrome-cdp-ex/experiment/showcase.html)

| Proof | Why it matters |
|---|---|
| [Smart Eye benchmark](https://endeavoryen.github.io/chrome-cdp-ex/experiment/benchmark.html) | Last measured release campaign (**v2.12.0**, 2026-07-12): 10/10 rounds across MCP, CLI, Killer Path, large-app stress, and five real-app profiles |
| [Redesign experiment](https://endeavoryen.github.io/chrome-cdp-ex/experiment/showcase.html) | Same page, same prompt, same rounds — richer perception produced the better result |
| [Killer Path](docs/examples/killer-path.md) | 60-second route: `doctor → open → perceive → act → evidence → report` |

> Numbers below are from that last measured campaign. v2.14.0 shipped distribution / MCP / skill packaging; regenerate a campaign before publishing new speed or token claims.

## Use this when

- The user is already logged in and you do not want to recreate state.
- The agent needs layout, visible styles, and interactive targets cheaply.
- Each click / fill should explain what changed.
- You need a trail: screenshots, logs, reports, checkpoints, replay, or a Playwright draft.

## Do not use this when

| Use Playwright for | Use `chrome-cdp-ex` for |
|---|---|
| CI suites in isolated browsers | Live user sessions and authenticated tabs |
| Deterministic locators and assertions | Agent perception, diagnosis, and recovery |
| Cross-browser test matrices | Chrome / CDP / Electron inspection |
| Fresh state per test | Long-session debugging and handoff reports |

## Five success cases

| Case | What the agent does |
|---|---|
| Logged-in dashboard inspection | `doctor → list → perceive` on the real dashboard |
| Action evidence after form input | `fill` / `click` return an Action Receipt (`changed`, `no-change`, `failed`, …) |
| CSS source tracing | `cascade @ref background-color` → winning selector and source line |
| Long-session debugging | `status`, `netlog`, `mock` / `clock` / `throttle`, `report` |
| Workflow capture and replay | `checkpoint`, `record-actions`, `export-playwright`, `replay` |

## Smart Eye Proof

Measured agent path: see → act → verify → recover → hand off. The last release-quality campaign (v2.12.0) ran 10 rounds: matched MCP/CLI, Killer Path, a 5000+ node large-app fixture, and five local real-app profiles.

| Proof point | Last measured run |
|---|---:|
| Release proof | **v2.12.0 live campaign** |
| Real-app targets | **dashboard, docs-app, auth-flow, data-table, canvas-heavy** |
| Campaign pass rate | **10/10 rounds** |
| Quality gate | **34/34 pass in each real-app round** |
| First useful observation | **2.225s avg** |
| First action evidence | **2.902s avg** |
| Useful observation tokens | **1,564 avg** |
| Max step output | **1,113 tokens** |
| Matched MCP / CLI | **100% pass; CLI used 2,481 fewer output tokens** |

[Benchmark page →](https://endeavoryen.github.io/chrome-cdp-ex/experiment/benchmark.html) · [v2.14.0 product release →](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.14.0)

```bash
npm run benchmark:campaign -- --rounds 10 --types mcp,cli,killer,large-app,real-app,real-app,real-app,real-app,real-app,cli --real-app-targets dashboard,docs-app,auth-flow,data-table,canvas-heavy --settle-ms 0 --json --output release-campaign.json
```

## Quick start

Shortest first run: [Killer Path](docs/examples/killer-path.md). Host matrix: [INTEGRATIONS.md](INTEGRATIONS.md).

### 1. Install

**Pinned release (v2.14.0):**

```bash
curl -L -o pi-chrome-cdp-2.14.0.tgz https://github.com/EndeavorYen/chrome-cdp-ex/releases/download/v2.14.0/pi-chrome-cdp-2.14.0.tgz
mkdir -p chrome-cdp-ex-v2.14.0
tar -xzf pi-chrome-cdp-2.14.0.tgz -C chrome-cdp-ex-v2.14.0 --strip-components=1
cd chrome-cdp-ex-v2.14.0
```

Checksum is published on the [GitHub Release](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.14.0). This project does **not** publish to the npm registry.

**Current `main`:**

```bash
git clone https://github.com/EndeavorYen/chrome-cdp-ex.git
cd chrome-cdp-ex
```

### 2. Wire your agent host

```bash
node scripts/setup.mjs --detect
node scripts/setup.mjs --for cursor --write   # Cursor → .cursor/mcp.json
# Claude:  claude --plugin-dir .
# Codex:   mkdir -p ~/.codex/skills && cp -r skills/chrome-cdp-ex ~/.codex/skills/
# Others:  node scripts/setup.mjs --for openclaw|hermes|pi|claude
```

### 3. Ready the browser

```bash
node scripts/setup.mjs --verify
./bin/chrome-cdp doctor
# or: node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
```

If CDP is not reachable:

1. Prefer enabling remote debugging at `chrome://inspect/#remote-debugging` (or `edge://inspect`).
2. Or, with consent, spawn an isolated profile:  
   `./bin/chrome-cdp spawn-debug-browser edge --port 9222 --url https://example.com`  
   (add `--headless --no-sandbox` in CI / headless environments).
3. For Electron, start with `--remote-debugging-port=<port>` and set `CDP_PORT=<port>`.

### 4. Golden path

```bash
./bin/chrome-cdp doctor
./bin/chrome-cdp list
./bin/chrome-cdp open https://example.com          # if list is empty
./bin/chrome-cdp use <target> --name app           # optional alias
./bin/chrome-cdp perceive app -C -d 8
./bin/chrome-cdp click app @ref                    # or: fill app <selector> <text>
./bin/chrome-cdp verify-click app @ref --expect-text "Saved"
./bin/chrome-cdp perceive app --since-action
./bin/chrome-cdp report app                        # --format json for handoffs
```

Loop: **perceive → act → ask what changed**. Action JSON uses `receipt.schema = chrome-cdp-ex.action-receipt.v1`.

**Requires:** Node.js 22+ (built-in WebSocket). Auto-detects Chrome, Chromium, Brave, Edge, and Vivaldi on macOS, Linux (including Flatpak), and Windows.

## How it works

One lightweight daemon per tab keeps CDP session context, console / network / navigation buffers, and structured next steps.

```text
doctor → list/open → perceive → click/fill → perceive --since-action → report
```

| Need | Start with |
|---|---|
| Understand the page | `perceive`, `controls`, `summary` |
| Act and verify | `click`, `fill`, `press`, `verify-click`, Action Receipt, `perceive --since-action` |
| UI smoke | `qa` |
| Reuse targets | `use`, `current`, `forget` |
| Debug live state | `status`, `console`, `netlog`, `report` |
| Trace styling | `cascade`, `styles`, `inject` |
| Preserve a session | `checkpoint`, `record-actions`, `export-playwright`, `replay` |
| Capture visuals | `shot`, `elshot`, `diff-shot` |
| Agent-native API | stdio MCP via `mcp-server.mjs` |

Full map: [docs/reference.md](docs/reference.md) · always-loaded skill: [SKILL.md](skills/chrome-cdp-ex/SKILL.md) · deep flags: [references/commands.md](skills/chrome-cdp-ex/references/commands.md).

## Docs

- [INTEGRATIONS.md](INTEGRATIONS.md) — Claude Code, Codex, Cursor, OpenClaw, Hermes, Pi
- [Killer Path](docs/examples/killer-path.md) — fastest dogfood route
- [Technical reference](docs/reference.md) — commands, MCP, Electron, WSL2, gates
- [Product strategy](docs/strategy/agent-browser-vision.md) — why this is not another Playwright
- [Self-improvement loop](docs/self-improvement-loop.md) — issue → test → PR → merge
- [v2.14.0 release](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.14.0) — notes, checksum, tarball

## Dogfood benchmark

Use the live benchmark before publishing performance or adoption claims. Visual proof: [benchmark.html](https://endeavoryen.github.io/chrome-cdp-ex/experiment/benchmark.html).

### Latest dogfood snapshot

Local run on 2026-07-12 (last measured release campaign, product label v2.12.0) against 5 safe local real-app fixtures: dashboard, docs-app, auth-flow, data-table, canvas-heavy. Timing starts after CDP is reachable. Publish competitor deltas only from measured baselines.

| Metric | Latest measured run |
|---|---:|
| Total time | 10.264s avg |
| Command calls | 24 per round |
| First useful observation | 2.225s avg |
| First action evidence | 2.902s avg |
| Golden path complete | 5.353s avg |
| Estimated output tokens | 12,323 avg |
| Useful observation tokens | 1,564 avg |
| Action evidence coverage | 6 auto-evidence actions per round; no failed criteria |
| Real-app targets | dashboard, docs-app, auth-flow, data-table, canvas-heavy |
| Stale-ref recovery | covered by all real-app adversarial profiles |
| Quality gate | 34/34 pass in all 5 real-app rounds |

Regenerate this table after meaningful command, perception, or benchmark changes:

```bash
npm run benchmark:campaign -- --rounds 10 --types mcp,cli,killer,large-app,real-app,real-app,real-app,real-app,real-app,cli --real-app-targets dashboard,docs-app,auth-flow,data-table,canvas-heavy --settle-ms 0 --json --output release-campaign.json
npm run benchmark:update-readme -- release-campaign.json README.md --html experiment/benchmark.html --date YYYY-MM-DD
```

Schema fixture: [`docs/benchmarks/measured-baselines.example.json`](docs/benchmarks/measured-baselines.example.json) (format only — regenerate local measured baselines before publishing comparison deltas).

### Promotion checklist

Do not publish README, marketplace, awesome-list, or social comparison claims unless:

- `npm run benchmark:killer -- --json` exits 0 and `gate.passed` is true.
- A 10+ round mixed campaign covers matched MCP/CLI, Killer Path, large-app stress, and all five local real-app profiles before release or high-difficulty claims.
- Total output, per-command output, first-action-evidence, and per-command latency gates pass; inspect the gate `culprit` before publishing speed or efficiency claims.
- Action JSON passes the Action Receipt contract gate: `eventId`, `dispatch`, `settlement.state/strategy/signals`, `observedDeltaDetails`, `blockingSignals`, `recoveryHint`, and executable `nextSteps`.
- Competitor comparisons use `npm run benchmark:killer -- --comparison-baselines ./baselines.json` with measured baselines, not the planning-only `heuristic-smoke-baseline`.
- `docs/examples/killer-path.md` still covers real browser perception, failed action recovery, CSS tracing, and export handoff.
- Workflow handoffs from `record-actions --format json` and `export-playwright --format json` distinguish exported, skipped, review-needed, and live-only steps.
- If any benchmark gate criterion fails, **block promotion** and fix the failed criterion before publishing the claim.

Methodology: [docs/reference.md#benchmark-gate](docs/reference.md#benchmark-gate).

## Contributor checks

```bash
npm test
npm run lint
npm run check:docs
npm run smoke:live
```

## Credits

- **Original**: [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) by Petr Baudis (daemon-per-tab architecture and core CDP client)
- **Contributors**: [ynezz](https://github.com/ynezz) (Flatpak paths), [Jah-yee](https://github.com/Jah-yee), [Rolf Fredheim](https://github.com/rolfredheim), [hussainweb](https://github.com/hussainweb)
- **This fork**: `@ref` system, perceive-first workflow, Action Receipts, MCP adapter, cross-host setup, recovery paths, and an 81-command live-session surface

## License

[MIT](LICENSE)
