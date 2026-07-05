# TODOs

## Shipped (3y-Mud feedback slice — 2026-04)

- [x] **`spawn-debug-browser` / `spawn`** — launch isolated debug profile (macOS/Edge/Chrome/Brave) without touching the user's main profile.
- [x] **Stale `@ref` errors** are classified — `daemon-start`, `navigation`, `dom-mutation` get distinct, actionable messages instead of a flat "Unknown ref".
- [x] **Single-character `press`** — letters, digits, and common punctuation now work; uppercase carries a Shift modifier.
- [x] **`perceive` viewport coordinates** — header explicitly states "viewport CSS px"; fixed/sticky elements get a `, fixed`/`, sticky` tag so agents stop chasing negative document Ys.
- [x] **`text` fallback chain** — comma-separated selector list is tried in order; `text --auto` extracts main content while excluding nav/aside/footer noise; `--exclude` adds custom strippers.
- [x] **`shot --quiet` / `--verbose`** — saved path is now the first stdout line by default; quiet drops all hint output; verbose retains the long DPR coordinate-mapping tutorial.
- [x] **`waitfor --any-of`** — wait for the first matching alternative (`勝利|敗北|逃跑成功`) within `--scope`.
- [x] **`waitfor --selector-stable`** — wait until a selector's text stops changing for `stableMs` (combat/animation settle).
- [x] **`dismiss-modal`** — clicks visible close buttons inside `[role=dialog]/dialog/[aria-modal=true]`, falls back to Escape; avoids the bare `press Space` foot-gun.
- [x] **`perceive --keep-refs` / `--last N`** — preserve interactive ref lines and trim long static-text logs (event-log pages no longer hide the input ref).
- [x] **`list` shows `about:blank`** — labelled `(blank tab)` so agents always have a usable target prefix.
- [x] **Daemon crash hint** — "Connection closed before response" now points at the runtime dir for stale sockets and recommends re-running `perceive` to restart.
- [x] **Lint** — fixed `no-useless-escape` regressions in record's mutation observer.

## Backlog

### Release 2.5

- [x] In-file command registry.
- [x] `--format text|json` parsing infrastructure.
- [x] `status --format json`.
- [x] `summary --format json`.
- [x] `console --format json`.
- [x] `perceive --format json`.
- [x] Initial `PerceptionModel`.
- [x] Explicit `SessionState`.
- [x] Docs contract checker.

### Release 2.6

- [x] Standard `ActionResult`.
- [x] Action evidence wrapper for mutating commands.
- [x] Live smoke assertions for `fill`, `press`, `click`, and `inject` evidence.
- [x] `perceive --since-action`.
- [x] Per-target daemon log file.
- [x] Session screenshot directory.
- [x] `record-actions`.
- [x] `replay`.
- [x] `report <session>` action timeline.

### Killer Path

- [x] `doctor` onboarding wizard — checks Node, install path, daemon sockets, fd limit, CDP reachability, then prints next commands for `list/open -> perceive -> act -> since-action evidence -> report`.
- [x] README "use / do not use / 5 success cases" rewrite. Priority: P1.
- [x] Action failure classifier for overlay, wrong frame, navigation, DOM rewrite, and timeout. Priority: P1.
- [x] Token-aware `perceive` scoring for important controls, errors, changes, and new UI. Priority: P1.
- [x] `overlay` / `overlays` detector — read-only dialog/overlay and target hit-test blocker diagnosis. Priority: P1.
- [x] Action Receipt v1 — `chrome-cdp-ex.action-receipt.v1` summarizes dispatch, settlement, observed delta, structured delta details, session event identity, blocking signals, recovery hint, and next steps. Priority: P1.
- [x] Target-aware no-change recovery signals — actions with no visible AX tree change emit relevant overlay, frame, and fresh-perception blocking signals. Priority: P1.
- [x] Benchmark gate requires Action Receipt completeness for action JSON handoffs. Priority: P1.

### Feature Roadmap (medium effort)

- [x] `perceive --since-action` — diff from the last mutating action baseline instead of the last manual `perceive`. Priority: P1.
- [x] `record-actions` — export the current session action log as replay-oriented text/JSON. Priority: P1.
- [x] `replay` — execute a recorded action artifact against the live page. Priority: P1.
- [x] `checkpoint` / `restore` — save/restore page state (cookies, localStorage, sessionStorage, URL) for stateful testing. Priority: P1.
- [x] `mock` / `throttle` / `clock` — request fixtures, network throttling, and `Date.now()` control. Priority: P2.
- [x] `summary --format json` — structured summary output for LLM tool-calling. Priority: P2.
- [ ] `tab-group` / `broadcast` — multi-tab coordination. Priority: P2.
- [x] `diff-shot` — visual regression diff between baseline + current. Priority: P2.
- [x] `frame` / `frames` — list CDP frame tree with stable `@fN` refs and parse `@fN:M` syntax. Priority: P1.
- [x] Frame-scoped perception/action refs — `perceive --frame @fN` emits `@fN:M` refs; `click`, `fill`, and `cascade` can resolve them. Priority: P1.
- [ ] `components` — React/Vue component tree + state inspection. Priority: P2.
- [ ] `emulate` — dark/light mode emulation. Priority: P2.
- [ ] Browser Use mapping doc — map Action Receipt, no-change recovery, and benchmark-gated handoffs to Browser Use contribution language. Priority: P2.
- [ ] Recovery policy registry — centralize diagnosis kinds, recovery strategies, priorities, commands, and verify commands. Priority: P2.

### Polish backlog

- [ ] Adaptive `perceive` line/token budget beyond `--last`, using page density, task context, and error state.
- [ ] `eval --raw` flag to bypass the auto-`JSON.stringify` of object results.
- [x] Per-target daemon log file at `<runtime-dir>/cdp-<target>.log` for post-mortem.
- [x] Session screenshot directory + report attachments.

## Distribution & Visibility

- [ ] **Research and submit to awesome-lists** — Find relevant awesome-lists (awesome-claude-code, awesome-browser-automation, etc.) and submit PRs. Check if a Claude Code plugin directory exists. Priority: P2. Depends on: README rewrite complete.
