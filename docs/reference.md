# chrome-cdp-ex Reference

> **Unreleased candidate:** repository metadata is v2.16.0; install links and measured release evidence remain pinned to published v2.15.0.

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

### Generated canonical index

<!-- chrome-cdp-ex:generated-command-surface:start -->
_Generated from the immutable command catalog; edit command metadata at its source, not this region._

| Command | Synopsis | Catalog policy |
|---|---|---|
| `help` | `help [command]` | `read / standard` |
| `list` | `list\|tabs\|ls [--format json]` | `read / standard` |
| `target` | `target --url URL\|--title TEXT [--exact] [--format json]` | `read / standard` |
| `tab-group` | `tab-group list\|create\|add\|remove\|delete\|show [--format json]` | `conditional-mutation / conditional` |
| `broadcast` | `broadcast <group> <cmd> [args...] [--format json] [--full-results]` | `mutation / mutation` |
| `use` | `use <target> --name <alias>` | `protected-mutation / mutation` |
| `attach` | `attach --port N --target <id> --name <alias>` | `protected-mutation / mutation` |
| `current` | `current [--format json]` | `read / standard` |
| `forget` | `forget <alias>` | `protected-mutation / mutation` |
| `perceive` | `perceive <target> [flags] [--format json]` | `read / standard` |
| `snap` | `snap <target> [--full]` | `read / standard` |
| `controls` | `controls <target> [-s selector] [--filter text] [--limit N] [--compact] [--format json]` | `read / standard` |
| `eval` | `eval <target> <expr>` | `script / raw-script` |
| `eval64` | `eval64 <target> <base64>` | `script / raw-script` |
| `call` | `call <target> <expr\|fn>` | `script / raw-script` |
| `elshot` | `elshot <target> <sel\|@ref>` | `read / standard` |
| `shot` | `shot <target> [file\|--annotate]` | `conditional-mutation / conditional` |
| `diff-shot` | `diff-shot <target> [--reset] [--threshold pct]` | `conditional-mutation / conditional` |
| `html` | `html <target> [selector]` | `read / standard` |
| `nav` | `nav <target> <url> [--perceive] [--format json]` | `mutation / mutation` |
| `mock` | `mock <target> [add\|clear]` | `mutation / mutation` |
| `clock` | `clock <target> [freeze\|offset\|reset]` | `mutation / mutation` |
| `throttle` | `throttle <target> [off\|offline\|slow-3g\|fast-3g\|lte\|custom]` | `mutation / mutation` |
| `status` | `status <target> [--runtime]` | `read / standard` |
| `console` | `console <target> [--all\|--errors\|--clear]` | `conditional-mutation / conditional` |
| `summary` | `summary <target>` | `read / standard` |
| `report` | `report <target> [--last N\|--all] [--format json] [--qa\|--summary] [--compact]` | `evidence / standard` |
| `checkpoint` | `checkpoint <target> [--unsafe-full] [--format json]` | `sensitive-read / sensitive-read` |
| `restore` | `restore <target> --file <path> [--format json]` | `mutation / mutation` |
| `record-actions` | `record-actions <target>` | `read / standard` |
| `export-playwright` | `export-playwright <target> [--format json]` | `read / standard` |
| `replay` | `replay <target> --file <path> [--format json]` | `mutation / mutation` |
| `frame` | `frame <target> [--format json]` | `read / standard` |
| `overlay` | `overlay <target> [sel\|@ref] [--format json]` | `read / standard` |
| `qa` | `qa <target> [--desktop WxH] [--mobile WxH] [--format json]` | `mutation / mutation` |
| `responsive-audit` | `responsive-audit <target> [--viewport WxH ...] [--out-dir DIR] [--format json]` | `mutation / mutation` |
| `verify-click` | `verify-click <target> <sel\|@ref> [--format json]` | `mutation / mutation` |
| `net` | `net <target>` | `read / standard` |
| `click` | `click <target> <sel\|@ref> [--js\|-j] [--format json] [--qa\|--summary]` | `mutation / mutation` |
| `jsclick` | `jsclick <target> <sel\|@ref>` | `mutation / mutation` |
| `clickxy` | `clickxy <target> <x> <y> [--format json]` | `mutation / mutation` |
| `type` | `type <target> <text> [--format json]` | `mutation / mutation` |
| `press` | `press\|key <target> <key> [--format json]` | `mutation / mutation` |
| `scroll` | `scroll <target> <dir\|x,y> [px] [--format json]` | `mutation / mutation` |
| `hover` | `hover <target> <sel\|@ref>` | `protected-mutation / mutation` |
| `waitfor` | `waitfor <target> <selector> [ms]` | `read / standard` |
| `loadall` | `loadall <target> <selector> [interval-ms] [--timeout-ms N]` | `protected-mutation / mutation` |
| `wait` | `wait <target> <ms>` | `read / standard` |
| `fill` | `fill <target> <sel\|@ref> <txt> [--format json]` | `mutation / mutation` |
| `select` | `select <target> <selector> <val> [--format json]` | `mutation / mutation` |
| `fullshot` | `fullshot <target> [file]` | `conditional-mutation / conditional` |
| `scanshot` | `scanshot <target>` | `read / standard` |
| `styles` | `styles <target> <selector> [--root auto\|body\|document\|<sel>]` | `read / standard` |
| `components` | `components <target> [--depth N] [@ref\|selector] [--max-chars N] [--unsafe-full] [--format json]` | `sensitive-read / sensitive-read` |
| `cookies` | `cookies <target>` | `sensitive-read / sensitive-read` |
| `cookieset` | `cookieset <target> <cookie>` | `mutation / mutation` |
| `cookiedel` | `cookiedel <target> <name>` | `mutation / mutation` |
| `dialog` | `dialog <target> [accept\|dismiss]` | `protected-mutation / mutation` |
| `viewport` | `viewport\|resize <target> [WxH]` | `mutation / mutation` |
| `emulate` | `emulate <target> [dark\|light\|no-preference\|off\|status]` | `mutation / mutation` |
| `upload` | `upload <target> <selector> <paths> [--format json]` | `mutation / mutation` |
| `text` | `text <target> [selector\|--auto]` | `read / standard` |
| `table` | `table <target> [TABLE_SELECTOR] [--format text\|json] \| table <target> [TABLE_SELECTOR] --collect --scroll-container SELECTOR [--load-more SELECTOR] [--row-key-column N] [--format text\|json] \| table <target> --continue TOKEN --format json` | `conditional-mutation / conditional` |
| `back` | `back <target>` | `mutation / mutation` |
| `forward` | `forward <target>` | `mutation / mutation` |
| `reload` | `reload <target>` | `mutation / mutation` |
| `closetab` | `closetab <target>` | `mutation / mutation` |
| `netlog` | `netlog <target> [--clear]` | `conditional-mutation / conditional` |
| `inject` | `inject <target> <flag> [content]` | `mutation / mutation` |
| `cascade` | `cascade <target> <sel\|@ref> [prop] [--format json]` | `read / standard` |
| `record` | `record <target> [ms]` | `conditional-mutation / conditional` |
| `evalraw` | `evalraw <target> <method> [json]` | `raw-cdp / raw-cdp` |
| `batch` | `batch <target> <cmds> [--parallel] [--format json]` | `composite / composite` |
| `flow` | `flow <target> "<steps>" [--format json]` | `composite / composite` |
| `repeat` | `repeat <target> <N> <cmd> [args]` | `composite / composite` |
| `doctor` | `doctor / ready [--format json]` | `read / standard` |
| `keepalive` | `keepalive <target> <ms>` | `protected-mutation / mutation` |
| `open` | `open [url] [--perceive] [--attach-timeout-ms N] [--ready-timeout-ms N] [--ready-selector sel] [--reuse-url] [--format json]` | `mutation / mutation` |
| `spawn-debug-browser` | `spawn-debug-browser [browser] [--port N] [--url URL] [--profile-dir DIR] [--exe PATH] [--format json]` | `mutation / mutation` |
| `dismiss-modal` | `dismiss-modal <target>` | `mutation / mutation` |
| `stop` | `stop [target] [--format json]` | `mutation / mutation` |
<!-- chrome-cdp-ex:generated-command-surface:end -->

## Agent Loop

The core loop is intentionally short:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node skills/chrome-cdp-ex/scripts/cdp.mjs list
node skills/chrome-cdp-ex/scripts/cdp.mjs open https://example.com
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
# For "what does this page say": node skills/chrome-cdp-ex/scripts/cdp.mjs text <target> --auto
node skills/chrome-cdp-ex/scripts/cdp.mjs click <target> @ref
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --since-action
node skills/chrome-cdp-ex/scripts/cdp.mjs report <target>
```

Use `--format json` when another agent or script needs structured handoff data instead of human text.
Default `open` returns the target prefix and a follow-up `perceive` command; pass `--perceive` only when you want the full dump in the same call.

## Baselines And Bounded State Checks

Create a fresh diagnostic baseline with `console <target> --clear`. It clears
both console and uncaught-exception buffers and resets unread cursors; unknown
console flags fail instead of silently reading the buffer.

For variable-length combat or dialogue, keep the mandatory finite cap and add
one page condition:

```bash
cdp repeat <target> 20 click "button[data-act='attack']" --until-text "戰鬥結束"
cdp repeat <target> 20 click ".continue" --until-selector "[data-ending]"
cdp repeat <target> 20 click ".continue" --until-selector-missing ".loading"
cdp flow <target> "click .save; assert selector .saved; assert text Saved"
```

Conditions are re-evaluated after every settled iteration. Cap exhaustion is a
non-zero result with the full transcript. Stable selectors remain required;
the loop never remaps stale `@ref` handles.

A halted `flow` is a command failure, including when it runs inside `repeat`.
The default fail-fast repeat stops on that turn and exits non-zero while
preserving the failed step and recovery handoff. `--continue` is the explicit
override for independent iterations and still reports accurate success/failure
counts. `wait dom stable` and `wait network idle` also fail the flow on timeout;
their diagnostics identify the timed-out condition and pending request count
when applicable.

Multi-statement async eval returns a simple trailing expression:
`eval <target> "const value = await Promise.resolve(42); value"` prints `42`.
Use an explicit `return` for ambiguous control-flow endings.

For large pages, `perceive --adaptive` (or `perceive --last auto`) chooses a text-row budget from page density and console errors. Explicit `--last N` always wins. If a search box is focused, blur it (`press Escape`) or `perceive -s main` so typeahead suggestions do not replace the page body; `--keep-typeahead` keeps the dropdown. On virtualized feeds, `perceive --cards` returns a capped `chrome-cdp-ex.cards.v1` article/listitem list instead of the AX dump. A leftover `--cards` dump with cards is the settle shape for the next `scroll`; unchanged virtualized windows stay `Outcome: no-change` / continue with Next `perceive --cards`. Card identity ignores relative-time chrome in article AX names (`· 2m`), including when the clock lives in the article name itself; a third article entering the window is still `Outcome: changed`.

## Install And Release Surface

Official releases live on GitHub, not the npm registry. Use the release tag, release notes, GitHub Pages proof page, and attached tarball as the publish surface.

Pinned install: [v2.15.0 release notes](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.15.0).

```bash
curl -L -o pi-chrome-cdp-2.15.0.tgz https://github.com/EndeavorYen/chrome-cdp-ex/releases/download/v2.15.0/pi-chrome-cdp-2.15.0.tgz
mkdir -p chrome-cdp-ex-v2.15.0
tar -xzf pi-chrome-cdp-2.15.0.tgz -C chrome-cdp-ex-v2.15.0 --strip-components=1
cd chrome-cdp-ex-v2.15.0
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

`attach` is the explicit form for recording a target plus `--port` / `--host`; `use` also accepts `9222/<target>` and stores that CDP port for later commands. Port-bound aliases resolve through live discovery on that CDP port (same as a no-port `use` / prefix), rather than treating the saved prefix as a full target id. If the daemon cannot start against an already-live tab, the error names the real failure instead of asking whether you clicked Allow in Chrome. `list --format json` includes aliases, and text `list` shows aliases next to matching tabs.

When many tabs are open, select by URL/title instead of guessing prefixes:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs target --url http://127.0.0.1:8788 --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs target --title "Agent Decision Lab"
node skills/chrome-cdp-ex/scripts/cdp.mjs open http://127.0.0.1:8788 --reuse-url
```

`list` ranks non-blank pages first and marks the recommended target. Ambiguous `target` matches return candidate URLs/titles plus exact follow-up commands. Target commands resolve ordinary prefixes from live discovery before daemon/cache state, validate the daemon-bound target id, and attempt one bounded rebind on a target mismatch. Structured target-command output includes `targetResolution` with requested, bound, and resolved ids.

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

It returns `chrome-cdp-ex.semantic-interaction.v1` with the action evidence plus text, network, and console assertions. Failed assertions exit non-zero (`Kind: assertion`). `--expect-status` is only meaningful with `--expect-request`; using it alone is a usage error. Text output keeps the same signals readable for human review.

`batch` exits non-zero when any step fails, including `chrome-cdp-ex.batch.v1` handoffs with `counts.failed > 0`. Unknown inner commands recover with `cdp help`.

`qa` is a higher-level smoke command for live UI checks:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs qa <target> \
  --desktop 1440x900 \
  --mobile 390x844 \
  --expect-text "Dashboard" \
  --no-console-errors \
  --format json
```

It captures page info, console health, desktop/mobile screenshots, perception summaries, and optional semantic checks. Add `--click <selector-or-ref>` to include a verified interaction before the final assertions. `qa` always restores the tab's original viewport, even when a screenshot times out.

For responsive regression checks, use `responsive-audit` (alias `visual-check`):

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs responsive-audit <target> --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs visual-check <target> --viewport 1440x900 --viewport 390x844 --out-dir /tmp/cdp-audit
```

It walks a bounded set of viewports (default desktop + mobile), captures screenshots outside the repo by default (session screenshot dir or explicit `--out-dir`), and reports overflow-x, shared page-health evidence, internally clipped controls, material fixed/sticky overlaps, console health, control counts, and a pass/warn/fail summary. After the last audited size it restores the tab's previous viewport, including when a screenshot times out. Mark an intentional scroll list with `data-cdp-audit-scroll="intentional"` (or use `role="listbox"` / `role="feed"`) to suppress expected off-viewport items.

Screenshot JSON records the winning capture method and retry count. A near-black frame is retried once with the alternate surface only when computed page appearance is light; legitimate dark pages are not retried.

Compact QA handoffs are also available on common commands:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --qa --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs click <target> @ref --qa
node skills/chrome-cdp-ex/scripts/cdp.mjs report <target> --qa --format json
```

MCP tools mirror these workflows: `select_target`, `responsive_audit`, plus `qa` flags on `perceive` / `click` / `report`, and `open_or_attach.reuseUrl`.

All QA surfaces use the same multi-signal page-health classifier. Visible text, controls, DOM size, body geometry, and a verified changed action override a transient or missing URL sample; loading samples are resampled once and otherwise remain explicit `indeterminate` evidence. Action `--qa` Page/URL is the page after the action, including click-navigation. Chrome PDF plugin tabs emit `chrome-cdp-ex.pdf-viewer.v1` from `perceive`, `perceive --cards` / `-s` / `--format json`, `perceive --qa` / `--summary`, `summary`, `text --auto`, `html`, `qa`, `report` / `report --qa`, `click --qa`, `visual-check` / `responsive-audit`, `snap`, `styles`, `cascade`, `fullshot`, and other PDF-plugin action receipts, with Next `cdp eval <prefix> "document.contentType"` instead of another perceive/text probe. A leftover `pdf-viewer.v1` dump is not an AX settle baseline; no-op `press Escape` / Arrow* / `click --js` / `scroll` stay `Outcome: no-change` / continue with Next `eval <prefix> "document.contentType"` when AX cannot observe a plugin change. `hover` snapshots settle-shape AX before mouseMoved, recaptures immediately, and discards an idle recapture without waiting for a later DOM mutation so a later no-op mutator does not steal hover's AX delta. A leftover `--cards` / `--role feed` dump with cards is the settle shape for the next `scroll`; unchanged virtualized windows stay `Outcome: no-change` / continue with Next `perceive --cards` instead of recapturing a full AX tree. Card identity ignores relative-time chrome in article AX names (`· 2m`), including when the clock lives in the article name itself; a third article entering the window is still `Outcome: changed`. 0-card leftovers still recapture default AX so a later `click --js` is visible.

See also [Browser Use mapping](browser-use-mapping.md) and [awesome-list outreach research](outreach/awesome-lists.md).

## Multi-tab groups

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs tab-group create auth AABB CC11
node skills/chrome-cdp-ex/scripts/cdp.mjs broadcast auth perceive -C -d 4
node skills/chrome-cdp-ex/scripts/cdp.mjs broadcast auth status --format json --full-results
node skills/chrome-cdp-ex/scripts/cdp.mjs tab-group show auth --format json
```

Groups are stored in the CDP runtime directory (not the git repo). `create`/`add` resolve each member against live tabs and fail closed for unknown prefixes (no ghost members). Prefer read-only broadcast commands unless mutation is intentional. JSON output bounds each target result or error and preserves a full retry command by default; `--full-results` is the explicit large-payload mode.

## Components (MVP)

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs components <target> --depth 4
node skills/chrome-cdp-ex/scripts/cdp.mjs components <target> @3 --max-chars 8000 --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs components <target> "#account-panel" --format json
```

Tree inspection works best with React/Vue dev builds or DevTools hooks. Production minification may strip component names. Targeted props/state inspection with a bare CSS selector or strict `@ref` currently requires React fiber; other detected frameworks fail explicitly instead of returning an unrelated tree. Tree previews and targeted props/state recursively redact sensitive fields and stay bounded by default; `--unsafe-full` deliberately disables those protections for an owned test page.

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

`fill --format json` defaults to `chrome-cdp-ex.fill.v1`: `{ value, changed, navigation, typeahead }` plus an optional `targetPrefix`. That receipt stays a few hundred bytes even when diagnosis/recovery envelopes are attached internally. Pass `--full` or `--unsafe-full` for the existing `chrome-cdp-ex.action.v1` envelope, or `--compact` for the compact action handoff. After a no-navigation typeahead fill, `perceive --since-action` summarizes as `textbox value set; N suggestion links` plus the suggestion labels instead of listing the rerooted AX tree. Live headers use `document.activeElement` (`Focused: <input>`), so that DOM focus counts as typeahead even when the AX role is missing from the header.

Common outcomes:

| Outcome | Meaning |
|---|---|
| `changed` | The page changed and the agent can usually continue. |
| `no-change` | The action dispatched but did not produce visible change; inspect overlay/frame/state before retrying. |
| `attention` | Console, network, or observation signals need diagnosis. |
| `failed` | Dispatch failed; use the recovery command. |
| `timeout` | The action may have happened, but post-action observation timed out. |

For `no-change`, the receipt exposes target-aware blocking signals. Click/fill-style actions get `overlay-check-needed` and only pass a selector/`@ref` into `overlay` when the action actually targeted one; frame-scoped targets such as `@f2:4` get `frame-check-needed`; every no-change action that still needs investigation gets `fresh-perception-needed`. Key-press no-ops (`Escape` / `Tab` / `Space`) and `dismiss-modal` when no dialog is present are expected no-change / `continue` — they do not send the agent to `overlay <key>`. Treat remaining blocking signals as "inspect before retry" and follow the matching `nextSteps`.

If dispatch succeeds but post-action observation fails internally, the action still returns `chrome-cdp-ex.action.v1` with an `observation-error` diagnosis instead of a generic CLI error.

`perceive --since-action` replays the causal diff from the last mutating command. `report --format json` packages the latest action, diagnosis, artifacts, recommendation, and timeline window.

## Daemon Freshness

Target commands check per-tab daemon metadata before dispatching work. If an existing daemon was started from an older checkout, or cannot report metadata, the CLI returns a `stale-daemon` recovery model with `cdp stop <target>` and `rerun the original command` in `nextSteps`. Use `--allow-stale-daemon` only for intentional long-running daemon sessions.

`stop [target]` now confirms cleanup instead of succeeding silently. Use `stop <target> --format json` for the versioned `chrome-cdp-ex.stop.v1` receipt, including the requested target, stopped or failed target prefixes, remaining sessions, and an explicit `noop` flag only when no daemon was active.

## CSS Source Tracing

Use `cascade` when the agent knows what looks wrong but needs the source rule:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs cascade <target> @ref background-color --format json
```

`cascade` returns the winning selector, overridden rules, source location, and edit target. `winner` / `editTarget` is the declaration that produces `computedValue`, including an injected `!important` rule that beats a non-important inline style. It also resolves common Vite, CSS Modules, and Vue source-map locations.

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

Missing restore/replay files are usage errors (`cdp help restore` / `cdp help replay`), not page failures. `diff-shot` fails closed if screenshot capture times out instead of reporting a fake 0% match.

Report, record-actions, export-playwright, and session JSONL artifacts redact common password, token, API key, authorization, cookie, and session patterns by default while preserving command names, keys, counts, domains, and paths for debugging. Password-like fill/type values are redacted in every `record-actions` field, including `commandArgs`, `dispatchText`, and effect samples. Replay does not guess empty fill text for incomplete commands; missing `text` is skipped or failed closed. Checkpoint JSON also redacts cookie values and sensitive storage keys by default. Use `checkpoint --unsafe-full --format json` only when you need a fully restorable artifact; that output intentionally includes raw cookies and storage values, so treat it like a secret.

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

It exposes curated tools for the killer path plus Tier-1 workflow coverage: `doctor`, `list_tabs`, `open_or_attach`, `select_target`, `perceive`, `controls`, `overlay`, `screenshot`, `click`, `verify_click`, `dismiss_modal`, `fill`, `viewport`, `qa_page`, `responsive_audit`, `report`, `navigate`, `press`, `wait_for`, `cascade`, `components`, `spawn_debug_browser`, `record_snapshot`, `session_checkpoint`, and allowlisted `run_command`. Mutating tools require `confirm: true`. MCP also advertises resources such as `chrome-cdp-ex://doctor/status` and session report/screenshot templates so large handoffs need not ride only on tool results.

Agent-facing defaults are intentionally compact: MCP `perceive` adds `--adaptive`, `controls` adds `--compact`, and bounded `report` calls add `--compact`. Set the matching tool argument to `false` only when the full response is worth the extra context.

Use the MCP benchmark when changing the adapter or tool surface:

```bash
npm run benchmark:mcp
npm run benchmark:cli
npm run benchmark:campaign -- --rounds 2 --types mcp,cli --json
```

Both routes execute task `problem-finding-v1` with the same six checkpoints: open, controls, overlay, dismiss-modal, verify-click, and report. Route recommendations compare these matched runs only; Killer Path/adversarial rounds are excluded.

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
npm run benchmark:campaign -- --types real-app --real-app-targets dashboard,docs-app,auth-flow,data-table,canvas-heavy --rounds 5 --json
npm run benchmark:campaign -- --rounds 10 --types mcp,cli,killer,large-app,real-app,real-app,real-app,real-app,real-app,cli --real-app-targets dashboard,docs-app,auth-flow,data-table,canvas-heavy --json
```

Use [`docs/benchmarks/measured-baselines.example.json`](benchmarks/measured-baselines.example.json) as the checked-in schema fixture for reviewers. Do not publish comparison claims from that example file; regenerate a measured `baselines.json` for the machine and browser under test.

Use `benchmark:campaign` for repeated live testing. It runs sequential rounds with unique CDP and HTTP ports, alternating matched MCP and CLI routes by default, then reports pass rate, latency, estimated output tokens, first-useful-observation time, culprit steps, and a deterministic candidate identity. That identity binds the product version to a SHA-256 digest of the runtime, benchmark, setup, package, and identity-owned source files. Failed, incomplete, or regression-fail campaigns exit nonzero; `--allow-failures` is only for intentionally collecting diagnostic output. Add `--types large-app` for the 5000+ DOM node, 1000-row, 200-control bounded-output stress gate.

Add `--types real-app --real-app-targets dashboard,docs-app,auth-flow,data-table,canvas-heavy` when a smoke page is too easy. Each profile has a distinct trait/probe contract, and output records generated coverage, exercised coverage, missing probes, target class, and culprit steps. These are safe local/test-only fixtures. Any future URL-backed profile must use an owned staging/test tenant, never customer data, personal accounts, or production workflows.

The README and GitHub Pages benchmark proof should use a current passing mixed campaign when making release-quality usability claims. For the v2.12.0 front-door snapshot, the command was:

```bash
npm run benchmark:campaign -- --rounds 10 --types mcp,cli,killer,large-app,real-app,real-app,real-app,real-app,real-app,cli --real-app-targets dashboard,docs-app,auth-flow,data-table,canvas-heavy --settle-ms 0 --json --output release-campaign.json
npm run benchmark:update-readme -- release-campaign.json README.md --html experiment/benchmark.html --date YYYY-MM-DD --version X.Y.Z
```

The public-proof updater validates all ten ordered rounds, every round gate, zero failures, the exact release route/profile inventory, and the artifact candidate identity against the current tree before it writes either README or benchmark HTML.

Killer Path gates include long-session report budget coverage. Any report handoff with 50 or more recorded actions must stay inside its JSON byte budget, expose `latestAction`, keep a bounded non-expensive `timelineWindow`, preserve recovery-critical receipt fields, and point to artifact paths instead of dumping all history.

Campaign summaries include a `routeRecommendation` block. When comparable MCP and CLI rounds are present, it compares pass rate, average total latency, first-useful-observation latency, first-action-evidence latency, and estimated output tokens, then returns `mcp`, `cli`, or `inconclusive` with a confidence level. Deltas are reported as `mcp - cli`; negative latency or token deltas mean MCP used less. Killer Path and adversarial rounds are excluded so replay stress does not pollute the matched-route decision.

Use `--adversarial-seed <seed>` on `benchmark:killer` when you need a replayable high-difficulty browser page. The generated page can compose overlay, stale-ref, iframe, shadow DOM, SPA route, slow-network, auth-wall, large-table, hidden-template, and canvas traits while preserving normal Killer Path selectors. Campaign failures include the seed and exact reproduction command in `issueDrafts`.

Add `--history <jsonl>` when running self-improvement loops. The campaign appends a compact record for each run and reports deltas against the previous record for pass rate, average output tokens, max step tokens, and slowest-step latency so regressions are visible before opening or merging follow-up fixes.

Add `--compare-baseline <json-or-jsonl>` during PR review when you need a before-after regression check against `main` or a saved campaign summary. The comparison reports pass-rate delta, average output-token delta, max-step token delta, slowest-step latency delta, and new culprit changes for both slowest and largest-output steps. JSONL baselines use the latest non-empty record, so a `--history` file can double as a compact review baseline.

When a campaign round fails, the summary includes issue-ready diagnostics with a suggested title, reproduction command, ports, failed criteria, culprit step, artifact paths, and labels. Use those drafts as the starting point for follow-up issues instead of hand-writing failure reports from raw logs.

For the repeatable issue -> fix -> review -> merge process, use the [self-improvement loop runbook](self-improvement-loop.md).

Direct live benchmark commands use an isolated run manager and fail fast if the configured live slot is already owned. Each owner record includes the benchmark name, run id, slot, CDP port, HTTP server port, profile directory, process id, and heartbeat timestamp, so interrupted runs can be reclaimed without hiding live owners. Prefer `benchmark:campaign` for repeated testing; it keeps one owner for the full sequence while allocating unique round ports to avoid cross-run CDP target contamination.

Publish comparison claims only when `gate.passed` is true and competitor baselines are measured, not the planning-only `heuristic-smoke-baseline`.

## More Detail

The always-loaded agent skill is [skills/chrome-cdp-ex/SKILL.md](../skills/chrome-cdp-ex/SKILL.md). Exhaustive command edge cases live in [skills/chrome-cdp-ex/references/commands.md](../skills/chrome-cdp-ex/references/commands.md). Cross-host install lives in [INTEGRATIONS.md](../INTEGRATIONS.md) and [docs/integrations/](integrations/).
