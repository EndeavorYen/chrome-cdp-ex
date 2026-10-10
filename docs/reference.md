# chrome-cdp-ex Reference

> **TL;DR** — This is the technical reference for `chrome-cdp-ex`: command map, action evidence behavior, browser setup, Electron/WSL2 notes, and benchmark rules. Start with the README when you want the product story.

## Command Map

Most workflows start with `doctor -> list -> open -> perceive -> click/fill -> perceive --since-action -> report`.

| Area | Commands |
|---|---|
| Discovery | `help`, `doctor`, `list`, `target`, `tab-group`, `broadcast`, `open`, `spawn-debug-browser`, `attach`, `use`, `forget`, `current`, `stop`, `closetab`, `keepalive` |
| Perception | `perceive`, `controls`, `summary`, `snap`, `frame`, `overlay`, `text`, `table`, `components`, `status`, `console`, `report`, `qa`, `responsive-audit` |
| Visual capture | `shot`, `elshot`, `fullshot`, `scanshot`, `diff-shot` |
| Interaction | `click`, `verify-click`, `jsclick`, `clickxy`, `type`, `press`, `scroll`, `hover`, `drag`, `fill`, `select`, `upload`, `dialog`, `dismiss-modal` |
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
| `list` | `list\|tabs\|ls [--unsafe-full] [--format json]` | `read / standard` |
| `target` | `target --url URL\|--title TEXT [--exact] [--format json]` | `read / standard` |
| `tab-group` | `tab-group list\|create\|add\|remove\|delete\|show [--format json]` | `conditional-mutation / conditional` |
| `broadcast` | `broadcast <group> <cmd> [args...] [--format json] [--full-results]` | `mutation / mutation` |
| `use` | `use <target> --name <alias>` | `protected-mutation / mutation` |
| `attach` | `attach --port N --target <id> --name <alias>` | `protected-mutation / mutation` |
| `current` | `current [--format json]` | `read / standard` |
| `forget` | `forget <alias>` | `protected-mutation / mutation` |
| `perceive` | `perceive <target> [flags] [--unsafe-full] [--format json]` | `read / standard` |
| `snap` | `snap <target> [--full]` | `read / standard` |
| `controls` | `controls <target> [-s selector] [--filter text] [--limit N] [--compact] [--format json]` | `read / standard` |
| `eval` | `eval <target> <expr>` | `script / raw-script` |
| `eval64` | `eval64 <target> <base64>` | `script / raw-script` |
| `call` | `call <target> <expr\|fn>` | `script / raw-script` |
| `elshot` | `elshot <target> <sel\|@ref> [file]` | `conditional-mutation / conditional` |
| `shot` | `shot <target> [file\|--annotate]` | `conditional-mutation / conditional` |
| `diff-shot` | `diff-shot <target> [--reset] [--threshold pct]` | `conditional-mutation / conditional` |
| `html` | `html <target> [selector]` | `read / standard` |
| `nav` | `nav <target> <url> [--perceive] [--format json] [--qa\|--summary] [--compact]` | `mutation / mutation` |
| `mock` | `mock <target> [add\|clear]` | `mutation / mutation` |
| `clock` | `clock <target> [freeze\|offset\|reset]` | `mutation / mutation` |
| `throttle` | `throttle <target> [off\|offline\|slow-3g\|fast-3g\|lte\|custom]` | `mutation / mutation` |
| `status` | `status <target> [--runtime] [--vitals] [--unsafe-full]` | `read / standard` |
| `console` | `console <target> [--all\|--errors\|--clear] [--unsafe-full]` | `conditional-mutation / conditional` |
| `summary` | `summary <target> [--unsafe-full]` | `read / standard` |
| `report` | `report <target> [--last N\|--all] [--format json] [--qa\|--summary] [--compact]` | `evidence / standard` |
| `checkpoint` | `checkpoint <target> [--unsafe-full] [--format json]` | `sensitive-read / sensitive-read` |
| `restore` | `restore <target> --file <path> [--format json]` | `mutation / mutation` |
| `record-actions` | `record-actions <target>` | `read / standard` |
| `export-playwright` | `export-playwright <target> [--format json]` | `read / standard` |
| `replay` | `replay <target> --file <path> [--format json]` | `mutation / mutation` |
| `frame` | `frame <target> [--unsafe-full] [--format json]` | `read / standard` |
| `overlay` | `overlay <target> [sel\|@ref] [--format json]` | `read / standard` |
| `qa` | `qa <target> [--desktop WxH] [--mobile WxH] [--format json]` | `mutation / mutation` |
| `responsive-audit` | `responsive-audit <target> [--viewport WxH ...] [--out-dir DIR] [--format json]` | `mutation / mutation` |
| `verify-click` | `verify-click <target> <sel\|@ref> [--format json]` | `mutation / mutation` |
| `net` | `net <target>` | `read / standard` |
| `click` | `click <target> <sel\|@ref\|name> [--js\|-j] [--format json] [--qa\|--summary]` | `mutation / mutation` |
| `jsclick` | `jsclick <target> <sel\|@ref\|name>` | `mutation / mutation` |
| `clickxy` | `clickxy <target> <x> <y> [--format json]` | `mutation / mutation` |
| `type` | `type <target> <text> [--format json]` | `mutation / mutation` |
| `press` | `press\|key <target> <key> [--format json]` | `mutation / mutation` |
| `scroll` | `scroll <target> <dir\|x,y\|to top\|to bottom> [px] [--scroll-container SELECTOR] [--format json] [--qa\|--summary] [--compact]` | `mutation / mutation` |
| `hover` | `hover <target> <sel\|@ref>` | `protected-mutation / mutation` |
| `drag` | `drag <target> <from sel\|@ref> <to sel\|@ref\|x,y> [--steps N] [--html5\|--pointer] [--format json]` | `mutation / mutation` |
| `waitfor` | `waitfor <target> <selector> [ms]` | `read / standard` |
| `loadall` | `loadall <target> <selector> [interval-ms] [--timeout-ms N]` | `protected-mutation / mutation` |
| `wait` | `wait <target> <ms>` | `read / standard` |
| `fill` | `fill <target> <sel\|@ref> <txt\|--secret NAME> [--format json]` | `mutation / mutation` |
| `select` | `select <target> <selector> <val> [--format json]` | `mutation / mutation` |
| `fullshot` | `fullshot <target> [file]` | `conditional-mutation / conditional` |
| `scanshot` | `scanshot <target>` | `read / standard` |
| `styles` | `styles <target> <selector> [--root auto\|body\|document\|<sel>]` | `read / standard` |
| `components` | `components <target> [--depth N] [@ref\|selector] [--max-chars N] [--unsafe-full] [--format json]` | `sensitive-read / sensitive-read` |
| `cookies` | `cookies <target> [--unsafe-full]` | `sensitive-read / sensitive-read` |
| `cookieset` | `cookieset <target> <cookie>` | `mutation / mutation` |
| `cookiedel` | `cookiedel <target> <name>` | `mutation / mutation` |
| `dialog` | `dialog <target> [accept\|dismiss]` | `protected-mutation / mutation` |
| `viewport` | `viewport\|resize <target> [WxH]` | `mutation / mutation` |
| `emulate` | `emulate <target> [dark\|light\|no-preference\|--focus\|off\|status]` | `mutation / mutation` |
| `upload` | `upload <target> <selector> <paths> [--format json]` | `mutation / mutation` |
| `text` | `text <target> [selector\|--auto]` | `read / standard` |
| `table` | `table <target> [TABLE_SELECTOR] [--format text\|json] \| table <target> [TABLE_SELECTOR] --collect --scroll-container SELECTOR [--load-more SELECTOR] [--row-key-column N] [--format text\|json] \| table <target> --continue TOKEN --format json` | `conditional-mutation / conditional` |
| `back` | `back <target>` | `mutation / mutation` |
| `forward` | `forward <target>` | `mutation / mutation` |
| `reload` | `reload <target>` | `mutation / mutation` |
| `closetab` | `closetab <target>` | `mutation / mutation` |
| `netlog` | `netlog <target> [--id N [--body] [--out file [--overwrite]]] [--type xhr,fetch] [--url text] [--status 4xx\|5xx\|failed] [--clear] [--unsafe-full] [--format json]` | `conditional-mutation / conditional` |
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

`click` takes a CSS selector, an `@ref`, or a button/link's visible text (`click <target> "Save changes"`). `text=Save` / `text="Save changes"` is an alias for the visible-text form with the same exact, whitespace-normalised match (not Playwright's substring match).

The mouse `click` path for a CSS selector or `@ref` hit-tests its click point before dispatch. When another element is on top (a fixed sidebar, sticky header, toast, or dialog), it sends nothing and exits 1 with `Error: click not sent: <BUTTON> "…" at (x,y) is covered by <…>`, `Kind: covered`. Next is `dismiss-modal` when the cover is a dialog, `overlay <target> <sel>` when the first fixed or sticky layer that does not contain the target and can receive pointer events covers most of the viewport, and `click <target> <sel> --js` for smaller page chrome, a `pointer-events: none` shell, or a fixed app shell that contains the target. A fully visible but covered target is scrolled to the viewport centre once and re-tested before failing. The target, a descendant, a non-clipping ancestor, or an activating `<label>` still counts as a hit.

After the mouse events are sent, a capture-phase probe bound to that element checks that the event landed in the same set. If the page received the gesture on something else, the click exits 1 with `Kind: misdirected` (the input was sent). If the page received nothing, the kind stays `no-input-events`. `clickxy` has no element to bind, so it keeps the page-level probe only.

`hover` dispatches `mouseMoved` and waits until the target matches `:hover` before printing `Hovering over …`. A background tab can take several seconds for Chrome to apply that move. The command does not activate the tab or raise the window. If `:hover` never matches, it exits 1 with `Kind: hover-not-delivered` and exactly one Next command: `CDP_BACKGROUND=0 cdp hover <target> <sel>` when the tab is hidden, otherwise `cdp perceive <target> -C -d 8`.

`click` and `jsclick` on a control that should react (a button, link, input, select, textarea, summary, option, label, or ARIA role `button` / `link` / `checkbox` / `radio` / `switch` / `tab` / `menuitem` / `option` / `combobox` / `slider` / `spinbutton` / `textbox` / `searchbox`) exit 1 with `Kind: click-no-change` when settle is Outcome: no-change. Expected no-change (clipboard, PDF viewer, and the other existing expected cases) stays exit 0. An AX change, navigation, new tab, download, or checkbox/select state change stays exit 0. A main-frame navigation, including one the page starts itself, drops the previous comparison baseline; the next click compares the loaded document. If that baseline cannot be captured, the receipt says the baseline is stale (`Outcome: dispatched`) and does not report `Kind: click-no-change`. The exit code is 1; kinds are not separate exit codes.

`click`, `fill` and `select` on a CSS selector wait up to 2 s for the element to be attached, visible (not required for `select`) and enabled, inside the same page evaluation that finds it. `--wait-ms N` sets the limit (at most 30000) and `--wait-ms 0` turns it off. A receipt that waited says so: `Clicked <BUTTON> "Save" (waited 640ms for attach)`. A disabled target (`disabled` or a disabled `<fieldset>`; for `click` also `aria-disabled="true"`) is not acted on: it exits 1 with `Kind: disabled` and Next `waitfor <target> '<sel>:not(:disabled):not([aria-disabled="true"])'`, or `perceive` when the selector matches several elements. `aria-disabled` is not enforced by browsers; `click <target> <sel> --js` clicks such a control on purpose. An `@ref` is checked for disabled without waiting. `--wait-ms 0` skips the wait for a zero-size target. A selector that still matches nothing after the wait fails as `Kind: selector`.

Use `--format json` when another agent or script needs structured handoff data instead of human text.
Default `open` returns the target prefix and a follow-up `perceive` command; pass `--perceive` only when you want the full dump in the same call.

## Baselines And Bounded State Checks

Create a fresh diagnostic baseline with `console <target> --clear`. It clears
both console and uncaught-exception buffers and resets unread cursors; unknown
console flags fail instead of silently reading the buffer.

A main-frame navigation cuts those buffers to the document that committed.
`perceive`'s `Console:` line, `summary`, `status`, and `console` (including
`--all` and `--errors`) then report only that document. Previous-document
console lines and exceptions are omitted, not shown as current. A child frame
or a same-document navigation (`pushState`, a hash change) does not cut.
`netlog` uses the same navigation but keeps a short lookback so the document
request remains; console has no lookback. An action receipt still reports a
console error or exception observed after that action's baseline, including
one thrown on the document that then navigated away. `reload` leaves those
console and exception entries in place, so an error thrown while the new
document loads is still reported. It still clears the navigation and network
buffers.

Each console entry and exception message is capped at 8 KB when the daemon
captures it. A cut entry carries `truncated: true` and `originalLength` in
`console`/`status --format json`, and text lines from `console`, `status`, and
`record` end with `… [truncated, N chars]` whenever they do not show the whole
entry. Action receipts redact only a bounded prefix of each entry, so a page
that logs a multi-megabyte data URL does not slow down every `click` or `fill`.

Console errors, warnings and uncaught exceptions are source-mapped when they are
printed by `console`, `status`, or an action receipt. A frame in a production
bundle reads `src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)`: the
original position first, the generated one in parentheses (1-based line and
column). The daemon keeps up to three frames per entry; `console` prints the
two caller frames as `at …` lines, and `--format json` entries carry them as
`stack`. The map comes from the script's trailing `//# sourceMappingURL=`
comment, either an inline `data:` URL or a file loaded through the page's
network stack with its cookies (no page script runs and the Debugger domain stays
off). Maps over 5 MB are skipped, and an output waits at most 1.5 s for map
loads. Only the first output waits on a load still in flight. A map host that
times out or is unreachable is retried after 5 s, then after a wait that doubles
up to 60 s. Parsed maps are cached per tab daemon, least recently used first out
past 32 MB, and cleared on the next top-level navigation. With no map, or when
it cannot be read in time, the generated frame is printed unchanged; source
mapping never fails a command.

For "why is this page slow or janky", run `status <target> --vitals` (it can be
combined with `--runtime`). It reads the entries the page already buffered for
`largest-contentful-paint`, `layout-shift`, `event`, `longtask` and
`long-animation-frame` (`PerformanceObserver` with `buffered: true`, observed for
about 120 ms and then disconnected) plus the navigation timing entry, and prints
at most about 600 characters. The vitals are collected before the console and
exception buffers are read, so entries logged during the window are printed in
the same call. The text covers:

- LCP time (from `activationStart`), with the element's selector and text.
- CLS (largest session window), with the top shifting selectors of that window.
  Each element is credited with the score of every shift in the window it took
  part in.
- INP over slow interactions only: one outlier is skipped per 50 page
  interactions (`performance.interactionCount` when available). When that pick
  falls below the 104 ms buffer threshold, INP is reported as `< 104 ms`
  (rated good, or unrated when the `event` buffer is full).
- Long-task and long-animation-frame (LoAF) counts, totals and worst durations.
- TTFB / DCL / load.

`status --vitals --format json` adds a `vitals` object (`chrome-cdp-ex.vitals.v1`,
with good / needs-improvement / poor ratings) to `chrome-cdp-ex.status.v1`;
without `--vitals` it is `null`. JSON adds `slowInteractions`,
`interactionCount`, `windowShifts`, LoAF `maxBlockingMs` and the slowest script.

Each timeline buffer keeps only the first 150 (`layout-shift`, `event`, LCP) or
200 (`longtask`, LoAF) entries of the page's life. When the browser reports
dropped entries (`droppedEntriesCount`), or a buffer holds its full capacity,
the metric carries `bufferFull: true` and `dropped` (the reported count, or
`null` when Chrome reported none). Chrome 154 reported 0 for a full LoAF buffer.
The text prints a `Buffer full, dropped:` line (`?` for an unknown count),
because those counts then cover only the start of the page.

An entry type the page does not support is `unavailable`, a supported type with
no entries is `none`, and a collection failure is reported as `unavailable` with
the reason instead of failing `status`. Chrome only buffers Event Timing entries
of 104 ms or longer, so faster interactions are not visible. URLs and
classic-script invokers lose their query and fragment, and then go through the
shared URL redactor (userinfo, sensitive path parameters such as
`;jsessionid=`).

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

Each `eval` gives `let`, `const`, and `class` their own scope, so
`eval <target> "const zz = 1; zz + 1"` prints `2` every time. The value is still
the last expression. `var`, `function`, and assignments to `globalThis` or
`window` stay on the tab. A leading `"use strict"` or `'use strict'` directive
still applies. A strict-mode `function` in a script that also uses `let`,
`const`, or `class` stays in that call.

For large pages, `perceive --adaptive` (or `perceive --last auto`) chooses a text-row budget from page density and console errors. Explicit `--last N` always wins. If a search box is focused, blur it (`press Escape`) or `perceive -s main` so typeahead suggestions do not replace the page body; `--keep-typeahead` keeps the dropdown. After fill, `press Enter` dispatches Enter to the focused element, including inside `batch`, and does not click a results link. `press Enter --search-submit` is the opt-in that submits a visible results listing (`See N model results` / `a[href*="models?search="]` / `/search?q=`) instead of the typeahead first repo. Sequential `batch --compact 'fill … | press Enter --search-submit'` skips mid-pipe fill leftover AX / `/api/quicksearch` settle (typeahead leftover is not the success signal), then `press` probes once (no 1500 ms typeahead poll) or opens `/models?search=<filled>` from the value just set, and returns on the listing URL, using `jsclick` or listing navigation so typeahead-overlay mouse compositor wait is not paid. The receipt says `Submitted search via <selector>` and does not claim a key press. A miss does not send Enter. A plain `press Enter` sends keyDown with a carriage return in `text` so the page receives keypress and the browser default action, including a click on the form default button and submit. Standalone fill still settle-diffs. `perceive -C -d 8` ranks that listing link first in Visible controls so `click` can use the same selector. `press Enter --search-submit` is report-only and does not eat leftover settle. On virtualized feeds, `perceive --cards` returns a capped `chrome-cdp-ex.cards.v1` article/listitem list instead of the AX dump. A leftover `--cards` dump with cards is the settle shape for the next `scroll`; unchanged virtualized windows stay `Outcome: no-change` / continue with Next `perceive --cards`. Card identity ignores relative-time chrome in article AX names (`· 2m`), including when the clock lives in the article name itself; a third article entering the window is still `Outcome: changed`. A leftover golden-path `perceive -C -d 8` dump is the settle shape for the next `scroll`; viewport `@ref` / Visible-control rect chrome, fold tags (`↑above fold`), and title-only Visible-control selector chrome (`span[title=…]` / `time` GMT) are not a page change. Unchanged identities stay `Outcome: no-change` / continue with Next `perceive -C -d 8` without a Recovery hint that restates that Next command. A Visible-control cap-swap stays `Outcome: changed` but the receipt summarizes the swap; samples prefer accessible names; live collector fallbacks (`img "img"` / `a role=link "link"`) stay in headline membership but do not fill the sample cap. Relative-time / GMT title strings (`2 days ago` / `Thu, 13 Aug 2026 15:18:27 GMT`) stay in headline membership but do not occupy the named 4-sample cap. Names that appear on both sides of a cap-swap (live: a shared commit title) stay in headline membership but do not occupy a named sample slot on both sides; unique file / heading / link names fill the cap. A new file, heading, or link still prints a structural diff. Next stays `perceive -C -d 8` on that leftover scroll, without a Hint `--since-action` double handoff or a generic `Recovery hint: Continue from the observed action evidence.` Honest leftover-ax-scroll receipts drop Interactive census / `Console: clean` / Coords clickxy tutorial chrome and do not reprint Outcome/Receipt/Verdict as the same sentence three times; the leftover `perceive -C -d 8` dump itself still prints those header lines. Honest leftover-ax-scroll `no-change` receipts whose Next is already `perceive -C -d 8` do not reprint `Recovery hint: AX identities unchanged; re-run perceive -C -d 8 instead of report.` They print `Outcome: no-change` without the settle-shape reason `Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.` Honest leftover-ax-scroll `no-change` receipts whose Next is already `perceive -C -d 8` also drop the reprinted `Page:` / `Viewport:` identity header; `Position:` on the action line already states scroll identity, and Next `perceive -C -d 8` re-establishes page identity. They also drop the tautological `(no changes detected in AX tree)` body; `Outcome: no-change` already states that. They also drop the tautological `scroll: dispatched via scroll` / `Target: down` restatement; `Scrolled by … Position: …` already states the action. Leftover-ax-scroll `changed` still prints dispatched/Target, Page / Viewport, and its AX body. Standalone leftover `perceive -C -d 8` dumps still print that no-change line.

## Install And Release Surface

Official releases live on GitHub, not the npm registry. Use the release tag, release notes, GitHub Pages proof page, and attached tarball as the publish surface.

Pinned install: [v2.21.0 release notes](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.21.0).

```bash
curl -L -o pi-chrome-cdp-2.21.0.tgz https://github.com/EndeavorYen/chrome-cdp-ex/releases/download/v2.21.0/pi-chrome-cdp-2.21.0.tgz
mkdir -p chrome-cdp-ex-v2.21.0
tar -xzf pi-chrome-cdp-2.21.0.tgz -C chrome-cdp-ex-v2.21.0 --strip-components=1
cd chrome-cdp-ex-v2.21.0
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

`list` ranks non-blank pages first and marks the recommended target. Ambiguous `target` matches return candidate URLs/titles plus exact follow-up commands. Target commands resolve ordinary prefixes from live discovery before daemon/cache state, validate the daemon-bound target id, and attempt one bounded rebind on a target mismatch. Structured target-command output includes `targetResolution` with requested, bound, and resolved ids. `--follow-url` re-binds a vanished prefix only for a target-taking read command when exactly one live page has the last-seen URL and title (not a blank or New Tab page). The JSON receipt then uses `targetResolution.status` `followed-url`. `list` takes no target. `click`, `nav`, `eval`, `shot`, and every other non-read command do not re-bind.

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

Screenshot JSON records the winning capture method, retry count, and each capture tier that failed before it. Each viewport is labelled with the requested size; a page without `<meta viewport>` reports its wider layout size as `layoutViewport` (text: `layout=980x2120`). A near-black frame is retried once with the alternate surface only where the paint stack predicts a light background; canvas, video, image, iframe, and background-image regions and legitimate dark pages are not retried. A capture that no tier can serve fails with `Kind: screenshot-capture` (JSON `error.message` names each tier and its CDP error) and Next `perceive`.

Compact QA handoffs are also available on common commands:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --qa --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs click <target> @ref --qa
node skills/chrome-cdp-ex/scripts/cdp.mjs report <target> --qa --format json
```

MCP tools mirror these workflows: `select_target`, `responsive_audit`, plus `qa` flags on `perceive` / `click` / `report`, and `open_or_attach.reuseUrl`.

All QA surfaces use the same multi-signal page-health classifier. Visible text, controls, DOM size, body geometry, and a verified changed action override a transient or missing URL sample; loading samples are resampled once and otherwise remain explicit `indeterminate` evidence. Action `--qa` Page/URL is the page after the action, including click-navigation. Chrome PDF plugin tabs emit `chrome-cdp-ex.pdf-viewer.v1` from `perceive`, `perceive --cards` / `-s` / `--format json`, `perceive --qa` / `--summary`, `summary`, `html`, `qa`, `report` / `report --qa`, `click --qa`, `visual-check` / `responsive-audit`, `snap`, `styles`, `cascade`, `fullshot`, and other PDF-plugin action receipts, with Next `cdp eval <prefix> "document.contentType"` instead of another perceive probe. `text --auto` on those tabs returns page-1 text from the PDF bytes. A leftover `pdf-viewer.v1` dump is not an AX settle baseline; no-op `press Escape` / Arrow* / `click --js` / `scroll` stay `Outcome: no-change` / continue with Next `eval <prefix> "document.contentType"` when AX cannot observe a plugin change. `hover` snapshots settle-shape AX before mouseMoved, recaptures immediately, and discards an idle recapture without waiting for a later DOM mutation so a later no-op mutator does not steal hover's AX delta. Sequential `batch --compact 'hover … | eval …'` skips that leftover AX recapture so CSS `:hover` (opacity / group-hover) is not raced; confirm `eval` is the success signal. Standalone hover still recaptures. Hover receipts name opacity/visible/groupHover from computed style when available. A leftover `--cards` / `--role feed` dump with cards is the settle shape for the next `scroll`; unchanged virtualized windows stay `Outcome: no-change` / continue with Next `perceive --cards` instead of recapturing a full AX tree. Card identity ignores relative-time chrome in article AX names (`· 2m`), including when the clock lives in the article name itself; a third article entering the window is still `Outcome: changed`. A leftover golden-path `perceive -C -d 8` dump is the settle shape for the next `scroll`; viewport `@ref` / Visible-control rect chrome, fold tags (`↑above fold`), and title-only Visible-control selector chrome (`span[title=…]` / `time` GMT) are not a page change. Unchanged identities stay `Outcome: no-change` / continue with Next `perceive -C -d 8` without a Recovery hint that restates that Next command. A Visible-control cap-swap stays `Outcome: changed` but the receipt summarizes the swap; samples prefer accessible names; live collector fallbacks (`img "img"` / `a role=link "link"`) stay in headline membership but do not fill the sample cap. Relative-time / GMT title strings (`2 days ago` / `Thu, 13 Aug 2026 15:18:27 GMT`) stay in headline membership but do not occupy the named 4-sample cap. Names that appear on both sides of a cap-swap (live: a shared commit title) stay in headline membership but do not occupy a named sample slot on both sides; unique file / heading / link names fill the cap. A new file, heading, or link still prints a structural diff. Next stays `perceive -C -d 8` on that leftover scroll, without a Hint `--since-action` double handoff or a generic `Recovery hint: Continue from the observed action evidence.` Honest leftover-ax-scroll receipts drop Interactive census / `Console: clean` / Coords clickxy tutorial chrome and do not reprint Outcome/Receipt/Verdict as the same sentence three times; the leftover `perceive -C -d 8` dump itself still prints those header lines. Honest leftover-ax-scroll `no-change` receipts whose Next is already `perceive -C -d 8` do not reprint `Recovery hint: AX identities unchanged; re-run perceive -C -d 8 instead of report.` They print `Outcome: no-change` without the settle-shape reason `Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.` Honest leftover-ax-scroll `no-change` receipts whose Next is already `perceive -C -d 8` also drop the reprinted `Page:` / `Viewport:` identity header; `Position:` on the action line already states scroll identity, and Next `perceive -C -d 8` re-establishes page identity. They also drop the tautological `(no changes detected in AX tree)` body; `Outcome: no-change` already states that. They also drop the tautological `scroll: dispatched via scroll` / `Target: down` restatement; `Scrolled by … Position: …` already states the action. Leftover-ax-scroll `changed` still prints dispatched/Target, Page / Viewport, and its AX body. Standalone leftover `perceive -C -d 8` dumps still print that no-change line. 0-card leftovers still recapture default AX so a later `click --js` is visible.

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
node skills/chrome-cdp-ex/scripts/cdp.mjs emulate <target> --focus
node skills/chrome-cdp-ex/scripts/cdp.mjs emulate <target> off --format json
```

`emulate` sets CDP media features (`prefers-color-scheme`, `prefers-reduced-motion`) for dark-mode and motion QA without raw DevTools calls.

## Action Evidence

Mutating commands such as `click`, `verify-click`, `qa` with `--click`, `fill`, `type`, `press`, `select`, `scroll`, `upload`, `nav`, `back`, `forward`, `reload`, `viewport`, `inject`, `restore`, and `dismiss-modal` return action evidence.

`viewport` / `resize` compares the size read back from the page with the request. A match is `outcome.status: changed`, `outcome.evidence: viewport`, and `verdict.status: continue` (`canContinue: true`), including when the accessibility tree did not change. The text receipt prints the one-line `Viewport:` result and includes an AX diff only when that tree changed. A mismatch keeps a non-success `verdict.status: investigate` whose reason names the requested size and the size read back. It does not add `fresh-perception-needed`. Other commands are unchanged: an unexpected AX no-change is still `verdict: investigate` with that blocking signal.

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
| Text output | Human quick read | Outcome, receipt status, blocking signals, recovery hint, settle line, and high-signal evidence samples. When a one-line `click` / `jsclick` / `fill` / `press` / `select` / `scroll` / `nav` receipt has no diagnosis-specific Next, it suggests the same tab (`perceive <target> --since-action`, or `perceive <target> -C -d 8` after a navigation; `list` only without a target); the one-line receipt does not print an Outcome word. Full diagnostic text and action JSON still carry outcome. A click on a link that opens another tab (`target=_blank`, a named target, or `<base target>`) reports `→ opened new tab <prefix> <url>`, exits 0, and its Next is `perceive <new-prefix> -C -d 8`; it fails with `Kind: no-navigation` only when neither this tab navigated nor a tab opened. A failed action prints `Error:` / `Kind:` / `Next:` and exits 1. A misdirected mouse click (`Kind: misdirected`) and a `click` / `jsclick` whose control should have reacted but settled as no-change (`Kind: click-no-change`, with an `Outcome: no-change` line) are failed actions. Expected no-change stays exit 0. |

For token-bound handoffs, add `--compact` to mutating action JSON and report JSON:

```bash
cdp click <target> @1 --format json --compact
cdp report <target> --last 1 --format json --compact
```

Compact action/report JSON keeps the executable handoff contract - `schema`, target/action identity, dispatch/settlement status, high-signal evidence, outcome/verdict, recommendation, next steps, and receipt recovery data - while trimming duplicated full diagnostic envelopes and long DOM evidence. Use the session JSONL path from `report` when you need the full audit trail.

`fill --format json` defaults to `chrome-cdp-ex.fill.v1`: `{ value, previousValue, changed, navigation, typeahead }` plus an optional `targetPrefix`. `previousValue` is what the control held before fill (`null` when unknown, `<redacted>` for a sensitive field). A field is sensitive when it is a password input, or when its selector, `name`, `id`, `autocomplete`, `aria-label`, `placeholder` or label text holds a secret key token split on `_`, `-` and camelCase (`#api_token`, `[name=client_secret]`, `#accessToken`, `session_id`, `card_number`) or names a card or one-time code (`autocomplete=one-time-code`, `cc-number`, `cc-csc`, `cc-exp`). Bare words that only make a URL key secret (`session`, `access`, `refresh`, `sid`, `cookie`, `card`) do not, so "Session name" or "Access level" stay readable and replayable. A sensitive field's typed and previous values are `<redacted>` in every receipt mode (text, `--format json`, `--compact`, `--full`, `--qa`, AX diff and diagnosis samples, a failure's `effects.failure.target`), the session log and `record-actions`, and its failure `Next` reads `?.value.length` instead of the value; `#search` or `#pinned-note` stay readable. `fill <target> <sel|@ref> ""` (MCP `text: ""`) clears the field through the native value setter and fires `input` plus `change`, so React/Vue controlled inputs see the clear; a missing text argument is still a usage error. The text receipt names the transition (`Cleared <INPUT> (was "Ada")`, or `value unchanged: already empty`, an expected no-change with `Verdict: continue`). When the control ends up holding something other than the requested text, fill fails (exit 1, `dispatch.ok=false`) with `Kind: fill-value-mismatch` if the value changed (for example `<input type=number>` rejects `abc`: `Value: "0.5" → "" (requested "abc"; <input type=number> rejected the text)`, `outcome.changed: true`, `effects.failure.value` / `pageChanged`) or `Kind: fill-no-change` if it did not. Their `Next` is a shell-safe `cdp eval <prefix> "document.querySelector('<selector>')?.value"` (single-quoted when the selector contains quotes); for an `@ref` it uses a selector resolved from the live node, or `perceive` when none can be built. That receipt stays a few hundred bytes even when diagnosis/recovery envelopes are attached internally. Pass `--full` or `--unsafe-full` for the existing `chrome-cdp-ex.action.v1` envelope, or `--compact` for the compact action handoff. After a no-navigation typeahead fill, `perceive --since-action` summarizes as `textbox value set; N suggestion links` plus the suggestion labels instead of listing the rerooted AX tree. Live headers use `document.activeElement` (`Focused: <input>`), so that DOM focus counts as typeahead even when the AX role is missing from the header.

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

The daemon auto-accepts JavaScript dialogs (alert, confirm, prompt, beforeunload) unless `dialog <target> dismiss` is set. That choice, the throttle profile, and mock rules are stored in `cdp-<targetId>.env.json` (mode 0600) and applied again when a new daemon starts for the tab. The netlog buffer and the action log are written to `cdp-<targetId>.observe.json` (mode 0600) when they change. The file keeps the last 100 netlog entries, the last 100 actions, and the last 100 environment steps, and it stays at or under 1 MiB. The first command result after a restart names what came back, for example `daemon restarted: dialog=dismiss, throttle=offline, 2 mocks restored, 3 netlog entries restored, 1 action restored`. When nothing was saved the counts are 0. When that observation file cannot be read, the line says the netlog buffer and the action log were reset because the saved record is unreadable, and `netlog` and `record-actions` say the saved log could not be read instead of looking empty. `closetab` removes the observation file. A record that cannot be parsed selects dismiss. `meta`, `list_raw`, and `_activate` do not consume the line. `closetab` removes the file. Extra files past 64 are removed only when they match the defaults; a dismiss mode, throttle profile, mock list, or unreadable file is kept. A command that cannot write the file fails instead of reporting the setting as saved. Each receipt names the dialogs answered while that action ran: the text adds `Dialog: confirm "Delete project?" → accepted` (at most three lines, then `Dialog: and N more`; an accepted `beforeunload` adds `(any unsaved changes on the page being left were discarded)`), and JSON adds the optional `effects.dialogs[]` `{ type, message, accepted, url?, handled? }` with the message redacted and capped at 200 characters, plus `effects.dialogsOmitted` past 5 entries. `report` repeats them per action. A dialog answered outside an action (between commands, or during a read-only command) appears only in `dialog <target>` history. In dismiss mode, a `beforeunload` prompt that cancels `reload` or `nav` makes the command fail with `Kind: navigation-cancelled` (exit 1, `dispatch.ok=false`). The page and its refs are unchanged. Next is `cdp dialog <target> accept`, then retry; the receipt also names `cdp status <target>` for keeping the unsaved changes. In dismiss mode, `reload` and `nav` wait up to 3 s for evidence, so a slow `beforeunload` handler is still caught. See `references/commands.md` → Dialog handling.

`click <target> <sel|@ref> --expect-download [--out DIR] [--timeout ms]` captures the file a click downloads (an "Export CSV" button that builds a blob, or a response with `Content-Disposition: attachment`). Before the click it sets `Browser.setDownloadBehavior` to `allowAndName` for the tab's browser context, waits for `Browser.downloadWillBegin` and a `completed` or `canceled` `Browser.downloadProgress`, and then always sets the behaviour back to `default`, also on failure and timeout. CDP cannot read the previous behaviour, so a browser that had another one set by other tooling ends at `default`. Chrome also drops the override when the daemon's connection closes, so a daemon that exits or crashes mid-wait does not leave it behind. Chrome reports every download in the browser; only one that begins in this tab's frames is captured. The file is renamed from Chrome's `<guid>` to the suggested name with path separators, reserved characters and device names removed, cut to 200 UTF-8 bytes, never overwriting (`report (1).csv`), and made owner-only (0600). Run one `--expect-download` at a time per browser: the setting belongs to the browser context, so concurrent ones disturb each other. The text receipt adds `Downloaded "report.csv" 12.4 KB sha256=… → <path>`, the outcome is `changed` with evidence `download`, and JSON adds `effects.download` `{ state, filename, bytes, sha256, path, url, dir, behavior }` with the URL redacted. The default folder is `cdp-<target>-downloads/` in the runtime directory (mode 0700), pruned with the tab's other runtime artifacts; on Linux it is RAM-backed (`$XDG_RUNTIME_DIR`), so pass `--out` for large files and to keep a file. The wait (`--timeout`, default 30000 ms, at most 600000) starts after the click. No download in that time is `Kind: timeout`, and a download still running then is cancelled. A download the browser cancels is `Kind: download-canceled`, and one that cannot be renamed into the folder is `Kind: download-save-failed`. They exit 1 with Next `perceive <target> --since-action`. A browser endpoint without `Browser.setDownloadBehavior` fails with `Kind: download-unsupported` before clicking. The flag is CLI-only; MCP clients use `run_command` (`command: "click"`, `confirm: true`). See `references/commands.md` → Download capture.

`perceive --since-action` replays the causal diff from the last mutating command. An element still on the page keeps its `@ref`; a new node gets the next number, printed on the added line. `perceive --diff` does the same. A plain `perceive` still numbers `@1..@N` in document order and prints every line. `report --format json` packages the latest action, diagnosis, artifacts, recommendation, and timeline window.

## Daemon Freshness

Target commands check per-tab daemon metadata before dispatching work. If an existing daemon was started from an older checkout, or cannot report metadata, the CLI returns a `stale-daemon` recovery model with `cdp stop <target>` and `rerun the original command` in `nextSteps`. Use `--allow-stale-daemon` only for intentional long-running daemon sessions.

A tab daemon that dies on an uncaught error writes `cdp-<target>.crash.json` (`chrome-cdp-ex.daemon-crash.v1`: kind, redacted message capped at 300 chars, redacted stack capped at 2000, mode 0600) in the runtime dir, and the client error for that request reads `Connection closed before response: the daemon for this tab crashed (<kind>: <message>)`.

The same exit, an idle timeout, and `SIGTERM` / `SIGINT` also append `kind: "session-end"` to `cdp-<target>.log` (`chrome-cdp-ex.session-event.v1`, `reason` `exception`, `idle-timeout`, or `signal`; a signal also sets `signal`). Other shutdowns use their own `reason` (`browser-disconnect`, `target-destroyed`, `target-detached`, `socket-lost`). The next daemon appends `session-start` (`restarted: true` when the file already had bytes) and does not truncate the earlier lines. An unknown `@ref` on that restarted daemon says the previous daemon's refs were cleared because this tab's daemon restarted, instead of `No refs have been assigned in this daemon yet`. When that restart line is present, the first user-visible command also prints `daemon restarted: ...` and replays `cdp-<targetId>.env.json` (dialog mode, throttle, mocks). The netlog buffer and the action log are loaded from `cdp-<targetId>.observe.json`, and the line names how many netlog entries and actions were restored. A saved record that cannot be read says those buffers were reset because the record is unreadable.

`stop [target]` now confirms cleanup instead of succeeding silently. Use `stop <target> --format json` for the versioned `chrome-cdp-ex.stop.v1` receipt, including the requested target, stopped or failed target prefixes, remaining sessions, and an explicit `noop` flag only when no daemon was active. A daemon whose browser is gone is reported as `already gone` (`goneTargets`, plus one `results` entry per daemon with `status` `stopped`, `gone` or `failed` and a `reason`); an unreachable daemon that is still running is killed by its recorded pid (`cdp-<target>.daemon.json` in the runtime dir) after a check that the pid is still that daemon. Remaining sessions count only targets with a live daemon (a running recorded pid or an endpoint that answers), not cached pages that never had one. Stop removes a socket or record only when it belongs to the daemon it confirmed dead: a record with a new pid or start time, or a socket that a connection timeout cannot prove free, is left in place.

A tab daemon exits after 20 min idle. The countdown pauses while a command runs, so a long `wait` or `loadall` is not cut off, and it restarts in full when the last running command ends. One request holds the pause for at most 65 min (`DAEMON_REQUEST_IDLE_PAUSE_MAX_MS`: the 1 h `wait` maximum plus 5 min), so a command that never finishes cannot keep its daemon alive forever. `meta` and `list_raw` probes do not pause or restart it.

Each tab daemon writes `cdp-<target>.log`, `cdp-<target>-screenshots/`, and `cdp-<target>.observe.json` into the runtime dir. Screenshots of logged-in pages can hold private data, so they are not kept forever. Once a new daemon has answered its first request (or 30 s after it starts listening, if no request comes), it removes, off the event loop, another tab's log, rotated log, screenshot folder, `cdp-<target>.observe.json`, and `cdp-<target>.crash.json` once the newest of them is older than 7 days, but always keeps the 20 newest tabs' sets (`RUNTIME_ARTIFACT_MAX_AGE_MS`, `RUNTIME_ARTIFACT_KEEP_NEWEST_TARGETS`). `closetab` removes the observation file immediately. Writes also drop the oldest readable observation files past 64. A file that cannot be parsed is kept, so the next daemon can say the saved log could not be read. A tab with a running daemon (a live recorded pid or a socket file) and the daemon's own tab are never pruned. A file Windows still holds open is skipped until a later start. A log that passes 5 MB (`SESSION_LOG_ROTATE_BYTES`) is renamed to `cdp-<target>.log.1`, replacing an older one, and a new log is started.

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
| Compare two visual states and name the changed regions | `diff-shot <target>` before and after the change |

Missing restore/replay files are usage errors (`cdp help restore` / `cdp help replay`), not page failures. `diff-shot` fails closed if screenshot capture times out instead of reporting a fake 0% match.

Report, record-actions, export-playwright, and session JSONL artifacts redact common password, token, API key, authorization, cookie, signature, and session patterns by default while preserving command names, keys, counts, domains, and paths for debugging. One key classifier (`scripts/lib/redaction.mjs`) splits keys on `_`, `-`, `.` and camelCase and matches whole tokens, so `access_token`, `client_secret`, `session_id`, `accessToken` and `api_key` are redacted while `pinned`, `cardinality` or `sidebar` are not. `token` used as a quantity (`tokens`, `maxTokens`, `tokenCount`) stays readable, and `key`, `sig` and `*Signature` (`X-Amz-Signature`) count as secrets only as URL query or fragment parameters, so `Sort key: name` is left alone. A quoted secret value is redacted through its real closing quote: escaped quotes (`\"`) and line breaks inside it are part of the value, and a quote with no closing quote within 4 KB is redacted up to that bound. JSON embedded in a JSON string (`{\"password\":\"…\"}`) and a value opened by an escaped quote (`password: \"…\"`) are read as the text they encode. An apostrophe in prose is read as a quote (`password: 'it's …'` closes after `it`), so such values can still leak. CSS selectors such as `#pin:checked` or `.token:hover` are never rewritten, so recorded workflows replay unchanged. The same rule redacts request URLs in action receipts (text and JSON), `net`, `netlog`, `mock` hits, `record` timelines, `report`, and the session log; among these, `netlog --unsafe-full` is the only way to print them raw. A JWT (`eyJ….eyJ….…`) is redacted wherever it appears, and `code=` in a URL counts as a secret only next to `state=` (an OAuth authorization response). `netlog <target> --id N` also redacts secret-named request and response headers (`Authorization`, `Cookie`, `Set-Cookie`, `X-*-Token`, `X-Api-Key`, `X-Hub-Signature*`, `X-Firebase-AppCheck`; `Access-Control-*` stays readable), parses JSON bodies and redacts them structurally (the result stays valid JSON), and redacts csrf/authenticity tokens in HTML, in the 4 KB body preview and in a body saved with `--out`. Body redaction is best effort. `--unsafe-full` lifts redaction but keeps the 4 KB preview bound; `--out` holds the whole body. `console` text, `cookies` values, and the page URL printed by `perceive`, `status`, `list`, `summary`, and `checkpoint` use the same mask. `--unsafe-full` prints the raw values. Fill values typed into a sensitive field (the field-name classifier applied to the selector, plus the control's type, `name`, `id`, `autocomplete` and label) are redacted in every `record-actions` field, including `commandArgs`, `dispatchText`, and effect samples. Replay does not guess empty fill text for incomplete commands; missing `text` is skipped or failed closed. Checkpoint JSON also redacts cookie values, URL secrets, and sensitive storage keys by default. Use `checkpoint --unsafe-full --format json` only when you need a fully restorable artifact; that output intentionally includes raw cookies, URL secrets, and storage values, so treat it like a secret. `fill <target> <sel|@ref> --secret NAME` types the value of `CDP_SECRET_<NAME>` (or `NAME` in the `CDP_SECRETS_FILE` dotenv file, refused on POSIX when group/other can read it) without the value ever entering argv, the MCP request, or a record: receipts, `fill.v1` `value`, report, record-actions, the session log, and errors show `<secret:NAME>`, and for the daemon's lifetime later output is scrubbed of values of 4+ characters (raw, JSON-escaped, and cut previews; JSON results inside strings only; best effort, so URL-encoded or HTML-entity copies are not caught). `broadcast` does not forward secrets. Recorded steps keep `--secret NAME`, so replay re-reads the secret at replay time and export-playwright emits `process.env.CDP_SECRET_NAME`. An unknown name is `Kind: usage` and lists names only. MCP `fill` takes `secret` instead of `text`.

## Browser Setup

Preferred path: use the browser you already have open, then enable remote debugging from `chrome://inspect/#remote-debugging` or `edge://inspect`.

When that is not available, spawn an isolated debug profile:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser edge --port 9222 --url https://example.com
node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser chrome --headless --no-sandbox --port 9222 --url https://example.com
```

`cdp help spawn-debug-browser` lists every flag (`--profile-dir`, `--daily-profile`, `--wait-ms`, ...). If port 9222 is already held by something that does not answer `/json/version` (for example Chrome's `chrome://inspect` toggle), spawn fails: pick another port such as `--port 9224` and set `CDP_PORT=9224` for later commands.

Configuration:

| Variable | Purpose |
|---|---|
| `CDP_PORT` | Connect to a specific debugging port. |
| `CDP_HOST` | Override the CDP host, default `127.0.0.1`. |
| `CDP_PORT_FILE` | Override the `DevToolsActivePort` file path. |
| `CDP_BACKGROUND` | Background mode is on by default: no command focuses a tab or raises the window. `0` (also `false`, `no`, `off`) turns it off. |
| `CDP_FOREGROUND` | `1` turns background mode off, like `CDP_BACKGROUND=0`. |
| `CDP_USAGE_LOG` | `1` appends `{ts, command, via}` (command name only, no arguments) to `<runtime dir>/usage.jsonl`, rotated above 1 MiB, local only. `npm run usage:report` reads it with local Claude Code and Codex transcripts and, by default, compares trailing `7d` and `30d` windows. `--since YYYY-MM-DD` keeps a single window. Off by default. |
| `CDP_CONTENT_BOUNDARIES` | `1` wraps page output (`perceive`, `text`, `console`, `table`, `netlog`, `back`/`forward`, `nav`/`open --perceive`) in nonce-marked `PAGE CONTENT (untrusted)` blocks. Off by default. |
| `CDP_ALLOWED_ORIGINS` | Comma-separated origins (`https://*.example.com` for subdomains). `nav`/`open`/`spawn-debug-browser --url` elsewhere fail with `Kind: policy`, commands do not run while the tab is elsewhere, and a command that navigates elsewhere fails after the fact. Unset by default. |
| `CDP_DENY_ACTIONS` | Comma-separated command names that exit 1 with `Kind: policy`, with the commands that do the same job (`eval` also denies `eval64`/`call`/`inject --js`; any list denies `evalraw`), also as `batch`/`flow`/`repeat`/`replay`/`record --action` steps and MCP tool calls. Unset by default. |
| `CDP_ISOLATED_ONLY` | `1` refuses to attach to a daily profile (the browser default user-data-dir or `chrome-cdp-ex/daily-*`) or to a browser whose command line cannot be read, with `Kind: policy`; auto-discovery then accepts isolated windows. `doctor` names a daily profile either way. Unset by default. |

The last four are opt-in session guardrails: defense-in-depth for agents, not a security boundary. Details and limits: `skills/chrome-cdp-ex/references/commands.md` (Session guardrails).

### Background mode

Background mode drives the browser without stealing focus from the user. **It is the default since #488**; before, it was opt-in with `CDP_BACKGROUND=1`.

- Tab daemons attach without `Target.activateTarget`, and the `open` navigate fallback skips it too. No command sends `Page.bringToFront`.
- `open` creates the tab in a new window without focus (`Target.createTarget {newWindow: true, background: true}`). A tab created with `background: true` alone would sit behind the active tab of an existing window and report `document.visibilityState: hidden`.
- Captures (`shot`, `elshot`, `scanshot`, `fullshot`, `annotshot`, `diff-shot`, and the screenshots of `responsive-audit` / `qa`) read `document.visibilityState` first. On a `hidden` tab (a background tab, or any tab of a minimized window) they make one plain `Page.captureScreenshot` limited to 3 s: Chrome renders a frame for some hidden tabs (0.2–3.1 s in live checks) and never for others, where the capture used to wait out its 30 s timeout. When no frame arrives, they turn on focus emulation (`Emulation.setFocusEmulationEnabled`) for one more 3 s capture and turn it off again afterwards. The tab is not activated: focus emulation makes the document visible, and a minimized window then renders in about 0.1 s in live checks. While the emulation is on, the page sees `visibilitychange` and focus events, and the receipt says so (#535). Only if that capture also gets no frame does the command fail with `Kind: hidden-tab`. For a capture command, `Next:` reruns it as `CDP_BACKGROUND=0 cdp <command> <target> ...`. For `flow`, `repeat`, `replay` or `batch`, whose earlier steps already ran, `Next:` is the capture alone (`CDP_BACKGROUND=0 cdp shot <target>`), never the whole recipe. The `fromSurface:false` and screencast fallbacks are skipped on a hidden tab, because `fromSurface:false` copies what the window shows, which is another tab. Visible tabs take the unchanged path. Headless Chrome (`--headless=new`) behaves the same in live checks: a tab from `open` is `visible`, a background tab in an existing window is `hidden` and stalls.

Opting out:

- `CDP_BACKGROUND=0` or `CDP_FOREGROUND=1` restores the old behaviour: tab daemons the call starts attach with `Target.activateTarget`, and `open` creates a focused tab and activates it in the navigate fallback. The call also sends its tab daemon an internal `_activate` request before the command, which activates the tab if it is hidden and waits up to 300 ms for it to report `visible`. This is what makes `CDP_BACKGROUND=0 cdp shot <target>` work on a tab whose daemon already runs in background mode. A visible tab is not activated again. When an activation leaves the tab hidden (a covered window, which Chrome cannot raise), later calls skip the wait until the tab is seen `visible` again. `_activate` is internal: `batch`, `flow`, `repeat` and `replay` refuse it as a step.
- `open --foreground` / `open --background` choose the mode for the tab `open` creates and pass it to its tab daemon. An explicit choice on `open` (flag or variable) is recorded for that tab (`cdp-<targetId>.mode.json` in the runtime dir), so a daemon restarted later for the tab (20 min idle exit, crash) keeps it when the restarting call does not choose; a choice in that call's environment wins. `closetab` removes the record; only the newest 64 are kept.
- `spawn-debug-browser --background` (or `CDP_BACKGROUND=1`) adds `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`, and, unless `--headless`, minimizes the launched window with `Browser.setWindowBounds` once CDP answers. The window can still appear briefly at launch. Without an explicit request, `spawn-debug-browser` does not minimize a window or pass the two throttling flags, which change how the browser schedules every background tab. It does pass `--disable-backgrounding-occluded-windows` by default, so a covered window keeps rendering (`--allow-occlusion` turns it off).

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser chrome --background --port 9224 --user-data-dir <dir>
CDP_PORT=9224 node skills/chrome-cdp-ex/scripts/cdp.mjs open https://example.com
```

Limits:

- A minimized window's tabs report `hidden`, so captures there may fail with `hidden-tab` (Chrome sometimes still renders them). The window that `spawn-debug-browser --background` minimizes is best left idle; do the work in tabs from `open`. `CDP_BACKGROUND=0` activates the tab; on Windows that also restored the minimized window in a live check.
- A hidden tab can drop `Input.*` events (known in headed Chrome); use `click --pointer` or page-side JavaScript there. For a background tab, `CDP_BACKGROUND=0` activates it first.
- A window that other windows cover can report `hidden` too (Windows native occlusion; macOS tracks occlusion as well). Neither mode raises it: Windows does not let Chrome bring itself to the front, so the old activating attach left a covered window covered too, and `CDP_BACKGROUND=0` does not change that. In live checks, clicks and captures in a covered window still worked, but clicks took about 3 s. Launch the browser with `--disable-backgrounding-occluded-windows` (see [Daily browser CDP](daily-browser-cdp.md)) and a covered window stays `visible` and fast; the cost is that covered windows keep rendering. `spawn-debug-browser` passes it, and `--disable-features=CalculateNativeWinOcclusion`, by default (`--allow-occlusion` drops both).
- Whether the unfocused window from `open` appears above other apps depends on the window manager; Chrome creates it without focus.
- The old attach also woke a sleeping (discarded) background tab with `Target.activateTarget` (#125); background mode does not. If a tab daemon fails to start on such a tab, rerun with `CDP_BACKGROUND=0`. This case has not been reproduced live.
- A daemon keeps the mode it attached with. A later call with no variable does not change it; a call with `CDP_BACKGROUND=0` only activates a hidden tab before its command.

When neither `CDP_PORT` nor a `DevToolsActivePort` file is present, discovery probes spawn-default `http://127.0.0.1:9222/json/version` first, then `http://127.0.0.1:9224/json/version` using the same path as `CDP_PORT` (including the HTTP 404 → `/devtools/browser` fallback), then the port of the last endpoint chrome-cdp-ex reached (`cdp-last-endpoint.json` in the runtime dir). Chrome 136+ often does not write that file. A live occupant is attach success (a leftover isolated `chrome-cdp-ex-*` profile is named instead, with `CDP_PORT=<port>` to use it); a closed 9222/9224 is still an environment miss — do not spawn a new debug profile. `doctor` and every attaching command (`list`, ...) run the same discovery and print the same diagnosis and `Next:` line.

When the remembered port is closed, the receipt is `relaunch-same-profile`: the exact browser line or `spawn-debug-browser` command for the profile last used on that port, with the flags it was launched with (`--headless=new`, `--no-sandbox`, `--disable-gpu`, `--disable-dev-shm-usage`, `--remote-debugging-address`, and the background-mode flags `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`, which the `spawn-debug-browser` form repeats as `--background`; `--disable-backgrounding-occluded-windows` alone is a `spawn-debug-browser` default and needs no option there), read from `spawn-debug-browser` or from the live browser's command line the last time chrome-cdp-ex attached to it. On Linux, attaching to a browser chrome-cdp-ex did not spawn (or after the record was deleted) also records its profile and flags: the main browser process that holds the listening socket on that port is found through `/proc`, and nothing is recorded when that is ambiguous. On Linux without `DISPLAY`/`WAYLAND_DISPLAY` the command always includes `--headless=new`. The raw browser line passes `--user-data-dir=<dir>`; Chromium reads `--user-data-dir <dir>` as a URL and starts another profile. If that profile's browser is still running (Chromium's `SingletonLock` names a live pid on this host), there is no relaunch: the receipt is `profile-in-use` (`error.code: cdp_profile_in_use`, with `pid`), and `Next:` is `CDP_PORT=<its port> cdp list` when the running browser has a debugging port, otherwise to enable remote debugging in it or quit it first.

`spawn-debug-browser` waits until `/json/version` answers before reporting success. If the browser exits early or CDP never becomes ready, the error includes captured stdout/stderr and a recovery command. `doctor` includes an `Environment` check and recommends `--headless --no-sandbox --exe <path>` when it detects Linux CI, containers, SSH-style remote shells, or no display.

## MCP Server

For agent-native workflows, run the stdio MCP adapter:

```bash
node skills/chrome-cdp-ex/scripts/mcp-server.mjs
```

It speaks MCP stdio framing: one JSON-RPC message per line in each direction. A client that sends LSP-style `Content-Length` headers gets header-framed replies; the first message sets the framing. A line that is not valid JSON gets a `-32700` parse error with `id: null` and the server keeps running. `ping` returns `{}`, and notifications (messages without `id`) never get a reply. Requests are answered one at a time, in arrival order. `initialize` echoes the client's `protocolVersion` when it is `2025-06-18` or `2024-11-05`. For any other dated version it answers with the newest supported version that is not newer than the request, and the oldest one if the request is older than both. A client accepts only versions it knows, so `2025-03-26` gets `2024-11-05`, which 2025-03-26-era SDKs accept. `2025-03-26` itself is not echoed: that revision requires accepting JSON-RPC batches, which this server rejects (`2025-06-18` removed batching again). A newer, unknown or missing version gets `2025-06-18`.

Every `tools/call` result starts with one text block holding the command output (stderr first, then stdout, on failure). Two extra views ride along:

- **Images.** `screenshot`, and `run_command` with `shot`/`screenshot`/`elshot`/`fullshot`, add an `image` block (`image/png`, base64) of the PNG the command wrote. The server reads only a fresh `.png` the CLI wrote into its runtime directory (`%LOCALAPPDATA%\cdp`, `$XDG_RUNTIME_DIR/cdp`, or `~/.cache/cdp`). The file must sit directly in that directory (`elshot`, `fullshot`, a `shot` without a tab daemon) or directly in a tab's `cdp-<targetId>-screenshots/` directory inside it (a daemon `shot`). Links are refused: the file must be a regular file, read through one descriptor, and the screenshot directory must be a real directory. The block is capped at 1 MiB of base64, about 768 KB of PNG, and the cap applies to the bytes actually read. A larger PNG, a relative or outside `screenshot` `path`, or a stale or non-PNG file gets a second text block saying why the image was not attached and where the file is. Images are not resized.
- **Structured content.** When stdout is versioned JSON (an object with a string `schema`, as `--format json` prints), the parsed object is also returned as `structuredContent`, including on failed calls. Tools do not declare an `outputSchema`.

`tools/list` gives each tool MCP `annotations` (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). They are derived from the owning command's catalog record, not written per tool:

- **readOnly, destructive and idempotent** come from `authorization`.
  - Only `standard` commands are read-only.
  - `sensitive-read` commands are neither read-only nor destructive, because `confirm` gates them.
  - `mutation` and `conditional` commands are destructive and non-idempotent.
- **openWorld** comes from `domains`. A command that talks to the live browser over any CDP domain returns or acts on untrusted web content, so it is open-world. This covers page readers such as `perceive`, `controls` and `list_tabs`. Only `report`, which reads the CLI's own session log, is closed-world.
- **`run_command`** takes the widest hints of its allowlist.

`benchmark:mcp` token budgets count text blocks only. Image base64 and `structuredContent` sizes are reported separately as `imageBase64Chars` and `structuredContentChars`.

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
