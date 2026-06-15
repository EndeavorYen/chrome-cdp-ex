---
name: chrome-cdp-ex
description: "Your EYES into the user's live Chrome browser and Electron apps. This skill lets you SEE and INTERACT with the user's actual browser or Electron app — their open tabs, logged-in sessions, and live page state. You MUST use this whenever the user's request involves browser content or Electron app inspection in ANY way.\n\nTRIGGER THIS SKILL when the user:\n- References pages they have open: 'I have X open', 'my tabs', 'open tabs'\n- Asks to look at, compare, or analyze anything in their browser: 'compare these pages', 'which looks better', 'check this page'\n- Mentions UI/visual analysis of live pages: 'dashboard', 'UI', 'layout', 'design quality'\n- Asks for screenshots or page inspection: screenshot, inspect, debug, check the page\n- Refers to 'the page', 'the browser', 'my tab' in any context\n- Mentions console errors, page state, or anything requiring browser access\n- Mentions Electron apps or CDP connections: 'Electron', 'electron app', 'CDP', 'CDP_PORT', 'DevTools Protocol', 'desktop app', 'remote-debugging-port'\n\nCRITICAL: NEVER say you cannot see the user's browser or ask users to paste screenshots. You CAN see their browser through this skill. Use `list` to discover open tabs, then `perceive` or `shot`/`scanshot` to see page content.\n\nDo NOT use Playwright — it launches an isolated browser without the user's login state, cookies, or open tabs."
---

# Chrome CDP

## TL;DR — 90% workflow

1. **Readiness:** `cdp doctor` — checks Node, install path, daemon state, fd limit, CDP reachability, browser debugging permission, and prints the next command to run.
2. **Discover/open:** `cdp list`; if empty, `cdp open <url>` or, with user consent, `cdp spawn-debug-browser edge --port 9222 --url <url>`.
3. **Observe:** `cdp perceive <target> -C -d 8` — structure, refs, top-level viewport CSS coordinates (fixed/sticky elements are tagged), console health.
4. **Interact:** `cdp click|fill|press <target> @ref|selector` — `@ref` is best for the immediate next step after `perceive`; **use a stable CSS selector for long batch/loop scripts** (refs are short-lived handles).
5. **Verify/report:** read the automatic action evidence, then use `cdp perceive <target> --since-action` or `cdp report <target>` for handoff. If you used `cdp throttle`, confirm the report shows the intended profile and reset with `cdp throttle <target> off`.

For long-session game / animation work also reach for `cdp waitfor <target> --any-of "win|lose|escape" 60000 --scope ".combat-log"` and `cdp waitfor <target> --selector-stable ".combat-log" 3000 60000`. To close MOTD-style modals safely without firing background shortcuts, use `cdp dismiss-modal <target>` (it prefers an explicit close button, falls back to Escape — never `press Space`).

## When invoked directly (`/chrome-cdp-ex`)

**Take action immediately — do not just read this document.**

1. Run `scripts/cdp.mjs list` to discover open tabs
2. Show the user what tabs are available
3. If the user's prior message references specific pages or content, match them to tabs and run `scripts/cdp.mjs perceive <target>` on the relevant tab(s)
4. If no specific request, ask the user which tab to inspect

Connects to the user's **existing Chrome browser** via CDP WebSocket. No Puppeteer, no new browser instance — works with the tabs, login sessions, and page state the user already has open. Only use Playwright when the user explicitly wants a fresh isolated browser for testing.

## Observation Strategy — Perceive First, Screenshot Last

> **Four-tier perception model:**
>
> | Tier | Command | When to use | Output |
> |------|---------|-------------|--------|
> | 1. **Perceive** | `perceive` | **Default starting point** for any page inspection | AX tree + layout + style hints (~200-400 tokens) |
> | 2. **Targeted visual** | `elshot <selector>` | Verify visual rendering of a **specific element** | Clipped PNG of one element |
> | 3. **Full visual** | `scanshot` | Last resort — pixel-level audit of **entire page** | Multiple viewport-sized PNGs (expensive!) |
> | 4. **Temporal** | `record` | Understand **what happened over time** — causality, sequence, settling | Timeline of DOM/network/console events |
>
> Always start with `perceive`. Use `record` when you need to understand **cause and effect** (e.g., "what happens after I click Submit?") rather than just the current state. See **"Verifying changes after actions"** and **"Temporal observation"** below.

### Observation workflow

> **CRITICAL: Never use `snap`/`snapshot` as your first observation command. Always use `perceive`.**

```
1. perceive <target>          ← ALWAYS start here (NOT snap/snapshot!)
   ↓ understand structure, content, layout, @refs, console health
2. elshot <target> <sel>      ← if you need visual verification of ONE element
   OR snap <target> --full    ← ONLY if perceive wasn't enough for AX detail
3. scanshot <target>          ← ONLY if you need full-page visual verification
```

### Verifying changes after actions

After modifying code or interacting with a page, choose your verification tool based on **what you need to confirm**:

| What to verify | Tool | Why |
|---|---|---|
| Content/structure changed | `perceive` — AX tree shows new/changed nodes | 100% accurate text from DOM |
| CSS styles applied (color, bold, bg) | `perceive` — style hints on table cells show `bg:rgb(...)`, `bold`, `color:rgb(...)` | Reads `getComputedStyle` directly — no pixel interpretation needed |
| Element exists/visible | `perceive` — node presence + `↑above fold`/`↓below fold` | Structured, not pixel guessing |
| Layout/spacing correct | `perceive` — `↕height`, `display`, `gap` on landmarks | Exact px values |
| Visual polish/aesthetics | `elshot <selector>` on the specific component | Only for **subjective** visual quality that can't be expressed as structured data |
| Animation/transition | `elshot <selector>` before and after | Only case truly needing pixel capture |
| What sequence of events an action causes | `record --action click @5` | Captures DOM mutations, network requests, console logs in chronological order |
| When the page becomes stable after action | `record --until "dom stable"` | Reports exact settle time + what happened before settling |
| Why something is slow or broken after navigation | `record <target> 5000` after `nav` | Correlates API calls → DOM updates → errors in a single timeline |

**Key insight:** `perceive` now includes **style anomaly detection** on table cells. If a cell has a non-default background color, bold text, or unusual text color compared to its column siblings, perceive annotates it directly (e.g., `[cell] 70.0%  bg:rgb(255,200,200)  bold`). You don't need a screenshot to verify conditional styling.

## Prerequisites

Pick one — listed in the order to try them on a fresh machine:

1. **Existing browser session** — open `chrome://inspect/#remote-debugging` (or `edge://inspect`) in Chrome / Chromium / Brave / Edge / Vivaldi and toggle the remote-debugging switch. Cleanest path when the toggle is reachable.
2. **Isolated debug profile (when the toggle path doesn't work, with user consent)** — `node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser edge --port 9222 --url https://example.com` launches a *separate* user-data-dir + `--remote-debugging-port` so you do not touch the user's main browser. macOS, Linux, and Windows browser paths are auto-detected; Linux also falls back to common browser names on `$PATH`, and `--exe /path/to/browser` handles non-standard installs. The disposable profile is at `/tmp/chrome-cdp-ex-<browser>-debug-profile-<port>`. Always confirm with the user before spawning.
3. **Electron apps** — set `CDP_PORT=<port>` (the app must be launched with `--remote-debugging-port=<port>` or `app.commandLine.appendSwitch('remote-debugging-port', '<port>')`).

Other requirements:

- Node.js 22+ (uses built-in WebSocket).
- If your browser's `DevToolsActivePort` is in a non-standard location, set `CDP_PORT_FILE` to its full path.

> **macOS / Edge note:** the previous skill text said never to suggest `--remote-debugging-port`. That advice was too absolute — when Edge is fresh-installed and `edge://inspect` has never been touched, the only realistic non-invasive option is the `spawn-debug-browser` helper above. It is safe because it uses a disposable profile.

### Electron screenshot notes

Some Electron builds do not respond to `Page.captureScreenshot` (CDP times out). When this happens, the tool automatically tries fallback methods in order: `fromSurface:false` capture, then screencast single-frame grab. You will see `(screenshot fallback)` or `(fallback)` in the output. Once a fallback is established, subsequent screenshots in the same session skip the failing tier — so `scanshot` (multi-segment) won't waste time retrying. If all screenshot methods fail, the error message will suggest using `perceive` instead. For Electron apps, `perceive` always works regardless of screenshot support.

## Agent Instructions

### WSL2 → Windows Browser (IMPORTANT)

When running inside WSL2 and controlling a browser on the Windows host:

**Do NOT improvise.** Follow this exact pattern — repeated attempts with other approaches (various IPs, curl, separate profiles, launching Chrome from WSL, etc.) have been proven to fail.

1. **Chrome must be started by the user on Windows** — do NOT attempt to launch or restart Chrome from WSL. Ask the user to open Chrome and enable remote debugging at `chrome://inspect/#remote-debugging`.
2. **WSL2 cannot connect to Windows localhost directly** — do NOT attempt `curl localhost:9222`, gateway IP routing, port forwarding, or any WSL→Windows network workarounds. They will all fail.
3. **Use Windows-side Node.js** to run the CDP script. The script must be executed by the Windows Node.js binary so it connects to Chrome on the Windows side natively.
4. **Finding Node.js on Windows from WSL**:
   ```bash
   # Step 1: Locate node.exe via PowerShell (most reliable)
   powershell.exe -NoProfile -Command "(Get-Command node -ErrorAction SilentlyContinue).Source"
   # Example output: C:\Users\simon.yen\tools\node-v24.14.0-win-x64\node.exe

   # Step 2: Convert to WSL mount path and invoke
   NODE_WIN="/mnt/c/Users/simon.yen/tools/node-v24.14.0-win-x64/node.exe"
   "$NODE_WIN" /path/to/scripts/cdp.mjs list
   ```
5. **Do NOT guess paths** like `/mnt/c/Program Files/nodejs/node.exe` — always use PowerShell to locate the actual installation. Ask the user if PowerShell also fails.
6. **Do NOT suggest `--remote-debugging-port`** restarts or separate `--user-data-dir` profiles. The correct prerequisite is `chrome://inspect/#remote-debugging` toggle only.

### Standard (non-WSL) environments

**Finding Node.js**: On Windows, `node` may not be in the bash PATH even if installed. If `node` is not found, use `powershell.exe -NoProfile -Command "(Get-Command node -ErrorAction SilentlyContinue).Source"` to locate it, then prepend its directory to PATH. Do NOT spend multiple attempts guessing paths — ask the user if PowerShell also fails.

### Invoking commands

The script is at `scripts/cdp.mjs` **relative to this skill's directory**. Use the full absolute path when invoking:
```bash
# Standard:
node ~/.claude/plugins/.../skills/chrome-cdp-ex/scripts/cdp.mjs <command> [args]

# Electron app (explicit port):
CDP_PORT=9222 node ~/.claude/plugins/.../skills/chrome-cdp-ex/scripts/cdp.mjs <command> [args]

# WSL2 (use Windows Node.js):
"$NODE_WIN" ~/.claude/plugins/.../skills/chrome-cdp-ex/scripts/cdp.mjs <command> [args]
```

**WSL2 efficiency tip**: Shell state doesn't persist between Bash calls. To avoid redefining `NODE_WIN` and `CDP` every time, **chain commands with `&&`** in a single Bash call:
```bash
N="/mnt/c/.../node.exe" C="/path/to/scripts/cdp.mjs" && "$N" "$C" fill FFCC @3 "prompt" && "$N" "$C" press FFCC Enter
```
Or define both vars at the start of each Bash call using short aliases.

On first use, always start with `list` to verify connectivity and discover available tabs.

**Interpreting `list` output**:
```
A7BA5C64  My Page Title    https://example.com/page
F39B10E2  Another Tab      https://other.site/path
```
When connected via `CDP_PORT` to an Electron app, a header line is shown:
```
[Electron 33.4.11]
1ED3DBAA  Rexiano          http://localhost:5173/#/menu
```
- Each line: `<8-char target ID>  <title>  <url>`. Use the target ID (e.g. `A7BA5C64`) for subsequent commands.
- **Empty output (exit 0)** = no debuggable tabs available. Do NOT stop to ask the user for help. Instead, use `open <url>` to create a tab — this will auto-attach, wait for the user to click "Allow debugging?" in Chrome, auto-perceive the page, and print Target/Next/Then/Report continuation hints. Once `open` completes, follow those hints and proceed immediately. Do NOT suggest `--remote-debugging-port` restarts.
- **Error output** = connection problem. Check prerequisites.

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list` (e.g. `A7BA5C64`). The CLI rejects ambiguous prefixes.

### Perceive page (recommended starting point)

```bash
scripts/cdp.mjs perceive <target>              # full page perception with @ref indices + coordinates
scripts/cdp.mjs perceive <target> --format json # versioned perception model for tool-calling agents
scripts/cdp.mjs perceive <target> --diff       # show only changes since last perceive
scripts/cdp.mjs perceive <target> --since-action # show changes caused by the last mutating command
scripts/cdp.mjs perceive <target> --frame @f2  # perceive inside a frame; refs become @f2:1
scripts/cdp.mjs perceive <target> -s "#main"   # scope to CSS selector subtree
scripts/cdp.mjs perceive <target> -x "nav, aside, [role=complementary]"  # exclude noisy regions
scripts/cdp.mjs perceive <target> -i           # interactive elements only (compact)
scripts/cdp.mjs perceive <target> -d 3         # limit tree depth to 3
scripts/cdp.mjs perceive <target> -C           # include non-ARIA clickable elements (@c refs)
```

Returns a single **enriched accessibility tree** that combines semantic structure with inline visual annotations:
- **Page header**: title, URL, viewport size, scroll position, console health, interactive element counts
- **Enriched AX tree**: semantic roles and labels with **inline layout annotations** — height, background color, font size, display mode, and viewport visibility (↑above fold / ↓below fold)
- **Style anomaly hints**: on table cells, annotates non-default background colors, bold text, and unusual text colors — e.g., `[cell] 70.0%  bg:rgb(255,200,200)  bold`
- **@ref indices with coordinates**: every interactive element gets `@1`, `@2`... with bounding rect `(x,y w×h)` — enables spatial understanding without screenshots
- **Scope/filter flags**: `-s` scopes to a subtree, `-i` shows only interactive elements, `-d N` limits depth — essential for large pages to avoid token bloat

Example output:
```
Page: Example Store — https://example.com/store
Viewport: 1280×720 | Scroll: 500/3000 (17%) | Focused: none
Interactive: 12 a, 3 button, 2 input[text]
Console: 2 errors, 1 warning

[WebArea] Example Store
  [banner]  ↕80px  bg:rgb(26, 26, 46)  ↑above fold
    [navigation] Main Menu
      [link] Home  @1  (20,25 60×20)
      [link] Products  @2  (100,25 80×20)
  [main]  ↕2920px
    [heading] Welcome to Our Store  36px 700
    [img] Hero Banner  ↕400px
    [region] Product Grid  grid  gap:20px
      [link] Product 1 — $29.99  @3  (50,500 200×30)
      [link] Product 2 — $49.99  @4  (270,500 200×30)
    [button] Add to Cart  @5  (50,550 120×36)
    [table] Department Health  ↕400px
      [row] header
        [columnheader] Department
        [columnheader] Failure Rate
      [row]
        [cell] LLM Technology  bold
        [cell] 33.3%  bg:rgb(255,235,200)
      ... more rows truncated
  [contentinfo]  ↕160px  bg:rgb(26, 26, 46)  ↓below fold
    [link] Privacy Policy  @6  (600,3000 100×16)
```

**@refs** are stable within a single perceive session. After navigation or DOM changes, run `perceive` again to refresh refs. The `(x,y w×h)` coordinates give spatial layout without needing a screenshot.

**@ref coordinates** enable spatial reasoning: "the Submit button is at (820,450) — bottom-right of the form" without taking a screenshot.

Hierarchy comes from the accessibility tree (always correct). Layout annotations are added to landmark/structural nodes. **Style anomaly hints** are added to table cells that deviate from their column's baseline. This is **the most efficient way** to understand a page. Use it before any screenshots.

### Perceive diff (track changes)

```bash
scripts/cdp.mjs perceive <target> --diff  # show only changes since last perceive
scripts/cdp.mjs perceive <target> --since-action  # show changes since the last action baseline
```

After performing an action (click, fill, etc.), prefer `perceive --since-action` when you need to re-check what that action changed; it compares the current page to the action's pre-dispatch baseline. Use `perceive --diff` when you specifically want changes since the last manual perceive. Both show added and removed AX tree lines and are much more token-efficient than a full re-perceive.

### Accessibility tree snapshot (advanced — rarely needed)

> **WARNING: Do NOT use `snap`/`snapshot` as your first command.** Always use `perceive` first.
> `snap` gives only the raw AX tree — no layout, no @refs, no coordinates, no console health, no style hints.
> Using `snap` instead of `perceive` means you lose 80% of page understanding and cannot use @ref-based interactions.

```bash
scripts/cdp.mjs snap <target>          # compact (default) — filters noise
scripts/cdp.mjs snap <target> --full   # complete AX tree with all nodes
```

Use `snap` **only** after `perceive` has already given you layout context and you need deeper AX tree detail for a specific debugging scenario.

### Element screenshot (targeted visual verification)

```bash
scripts/cdp.mjs elshot <target> <selector>   # screenshot by CSS selector
scripts/cdp.mjs elshot <target> @3           # screenshot by @ref from perceive
```

- Automatically scrolls the element into view and clips the capture to its bounding box
- Adds 8px padding around the element for context
- **No DPR confusion** — the clip is in CSS coordinates, handled by CDP
- **No scroll position errors** — scrollIntoView + clip guarantees the right content
- Use when you need to verify visual appearance of a specific component

> **Prefer `elshot` over `shot`** when you need to visually verify a specific element. It's more reliable and captures exactly what you need.

### Annotated screenshot (visual ref map)

```bash
scripts/cdp.mjs shot <target> --annotate   # viewport screenshot with @ref overlays
scripts/cdp.mjs shot <target> -a           # shorthand
```

Overlays red bounding boxes and `@ref` labels on every interactive element. Requires `perceive` to be run first (to populate refs). Useful for bug reports, visual debugging, and understanding which ref corresponds to which visual element.

### Viewport & full-page screenshots

```bash
scripts/cdp.mjs shot     <target> [file]  # viewport screenshot
scripts/cdp.mjs diff-shot <target> [--reset] [--threshold pct]  # viewport pixel diff against last baseline
scripts/cdp.mjs scanshot <target>         # segmented full-page (multiple viewport-sized images)
scripts/cdp.mjs fullshot <target> [file]  # single full-page image (may be tiny on long pages)
```

- **`shot`** — viewport only. Use when you need the currently visible area as pixels.
- If `[file]` is omitted, `shot` saves under the session screenshot directory and `report <target>` lists it as an attachment.
- **`diff-shot`** — first call captures a viewport baseline; later calls save current + diff PNG artifacts and changed-pixel ratio. Use only when structured `perceive`/`cascade` evidence is not enough; it is pixel diff, not semantic diagnosis.
- **`scanshot`** — scrolls through and captures multiple viewport-sized images with 10% overlap. Use when you need pixel-level verification of an entire page.
- **`fullshot`** — single image of entire page. **Do NOT use for analysis** — on long pages text becomes unreadably small. Only for non-AI consumption.

### Evaluate JavaScript

```bash
scripts/cdp.mjs eval <target> <expr>
scripts/cdp.mjs eval <target> --b64 <base64>   # decode UTF-8 base64 first
scripts/cdp.mjs eval64 <target> <base64>       # alias for `eval --b64`
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

> **CJK / shell-hostile expressions:** quote-mangling across bash / zsh / PowerShell makes naive
> `eval` calls with Chinese / Japanese / Korean text or embedded quotes unreliable. Encode the
> expression in base64 (`printf '%s' 'expr' | base64`) and pass it through `eval64` or
> `eval --b64`. The decoder validates the payload, so corrupt input fails loudly instead of
> silently evaluating a fragment.

### Page status, console, and session report

The daemon buffers console output, exceptions, and action evidence in the background from the moment it starts. Use these commands to query the buffer or summarize the session.

```bash
scripts/cdp.mjs status  <target> [--format json]                  # page state + new console/exception entries
scripts/cdp.mjs summary <target> [--format json]                  # token-efficient page overview (~100 tokens)
scripts/cdp.mjs console <target> [--all|--errors] [--format json] # console buffer (default: unread only)
scripts/cdp.mjs frame   <target> [--format json]                  # frame tree with @fN refs (alias: frames)
scripts/cdp.mjs overlay <target> [sel|@ref] [--format json]       # detect dialogs/overlays and hit-test blockers
scripts/cdp.mjs report  <target>                                  # action timeline + evidence + screenshot attachments + JSONL log path
scripts/cdp.mjs checkpoint <target> [--format json]                # capture URL, cookies, localStorage, and sessionStorage
scripts/cdp.mjs restore <target> --file <path>                     # restore a checkpoint artifact; invalidates @refs
scripts/cdp.mjs record-actions <target> [--format json]           # export session action log as replay-oriented steps
scripts/cdp.mjs export-playwright <target>                         # export current action log as a Playwright spec draft
scripts/cdp.mjs diff-shot <target> [--reset] [--threshold pct]     # viewport pixel diff against last diff-shot baseline
scripts/cdp.mjs replay <target> --file <path>                     # execute replayable steps from a record-actions artifact
```

> **Agent tip:** `perceive` already includes summary + console health. Use `status` or `console` only when you need to check for **new** console entries after an action.
> Use `frame`/`frames` when an action is classified as `wrong-frame` or the page contains iframes; it lists stable `@fN` frame refs. Then run `perceive <target> --frame @f2` to assign frame-local element refs such as `@f2:4`. `click`, `fill`, and `cascade` can use those refs directly.
> Use `overlay <target>` when a click/fill feels blocked or action failure says `overlay`; use `overlay <target> @ref` to ask whether a specific target point is covered. If blocking is reported, run the printed `dismiss-modal` command before retrying.
> Use `report` when handing off or after a multi-step flow; it summarizes action evidence accumulated in this daemon session, lists session screenshot attachments, and shows the per-target JSONL log path for post-mortem review.
> Use `checkpoint --format json` before risky stateful exploration, then `restore --file checkpoint.json` to return to the captured URL, cookies, localStorage, and sessionStorage. After restore, run `perceive` before using any `@ref`; refs from the prior page state are intentionally invalid.
> Use `record-actions --format json` when a successful exploration should become a replay/export asset, `export-playwright` when you want a reviewable Playwright spec draft from the portable subset, `diff-shot` when a fallback visual pixel diff is needed, then `replay --file artifact.json` to run replayable steps against a live page. Incomplete commands are marked with explicit missing fields instead of guessed. Password-like fill/type targets are redacted before action artifacts are written.
> Use `--format json` when another tool or agent needs a stable, parseable status, summary, console, or action-record payload.

### Batch commands (reduce IPC overhead)

```bash
# Pipe syntax (preferred — concise, easy to write):
scripts/cdp.mjs batch <target> 'fill @3 hello | fill @5 world | click @7'

# JSON syntax (still supported):
scripts/cdp.mjs batch <target> '[{"cmd":"fill","args":["@3","hello"]},{"cmd":"click","args":["@7"]}]'

# Parallel execution (for independent commands like multiple screenshots):
scripts/cdp.mjs batch <target> --parallel 'elshot @3 | elshot @5 | elshot @7'

# Human-readable output (no JSON parsing needed):
scripts/cdp.mjs batch <target> --plain   'click @7 | console --errors'
scripts/cdp.mjs batch <target> --compact 'click @7 | console --errors'   # one line per step
```

Executes multiple commands in a single IPC call. Default output is a JSON array of results.

- **Pipe syntax**: commands separated by `|`, args separated by spaces. Auto-detected when input doesn't start with `[`.
- **`--parallel`**: runs all commands concurrently via `Promise.all`. Safe for: `elshot`, `eval`, `html`, `text`, `table`, `styles`, `cookies`. Rejected for commands that auto-perceive (`click`, `fill`, `scroll`, `nav`, `perceive`, etc.) since they mutate shared state.
- **`--plain`**: human-readable per-step output. Each step gets a `[i/N] cmd args` header followed by indented result text. Use when an agent doesn't need to parse the result programmatically.
- **`--compact`**: one line per step (`[i] cmd: <first line of result>`). Useful for quick visual scans.

### Flow (sequential pipeline with halt-on-error)

```bash
scripts/cdp.mjs flow <target> "click @1; wait dom stable; summary; console --errors"
scripts/cdp.mjs flow <target> "fill @3 hello; click @7; wait network idle; perceive --since-action"
```

Runs the steps in order, halting on the first failure. Output is a readable step-by-step layout (not a JSON blob), so you can diff a failing pipeline at a glance.

- Each step is either a normal command (`click @1`, `summary`, `console --errors`, …) or a wait alias.
- Wait aliases use the same settle helper as `record --until`:
  - `wait dom stable` — wait for DOM mutations to quiet for 500ms (max ~10s).
  - `wait network idle` — wait until pending XHR/Fetch/Document requests drain.
- Use `flow` for short pipelines that read top-to-bottom; use `batch` when you need parallelism or programmatic JSON.

### Doctor / readiness check

```bash
scripts/cdp.mjs doctor    # one-call diagnostics (no target needed)
scripts/cdp.mjs ready     # alias
```

`doctor` is the onboarding wizard. It starts with a `Wizard` summary showing current status, the next command, and the golden path. It then checks Node 22+, the skill install path, daemon sockets, open-file limit, CDP reachability, debuggable page targets, and whether browser debugging approval is already confirmed. When ready, follow its printed path: `open` if no page exists, or `list` then `perceive <printed-prefix> -C -d 8`, click Allow if Chrome asks, `click`/`fill`, `perceive --since-action`, then `report`.

Reports `[OK]` / `[WARN]` / `[FAIL]` for: Node version, skill install path, daemon socket state, open-file limit, CDP reachability (CDP_PORT or auto-discovered DevToolsActivePort), debuggable tab inventory, and browser permission. Exits with code 1 if any check fails. Run this **first** when an agent is unsure whether the environment is wired up.

### Error handling

When a CLI command fails, read and follow the printed `Next:` line before retrying. Setup, target, daemon, and CDP errors are formatted as actionable recovery commands such as `cdp doctor`, `cdp list`, `cdp open https://example.com`, or `cdp perceive <target> -C -d 8`.

### Action feedback (automatic)

These commands **automatically wait for DOM to settle and return compact `ActionResult` evidence plus perceive feedback** — no need to manually run `perceive` or `perceive --diff` afterwards. Action feedback also snapshots console, exception, and network buffers before dispatch, then reports low-token deltas like `Console: 1 entry (1 error)`, `Network: 1 request (1 failed)`, or `Network: 1 request (1 pending)` when the action caused runtime failures, request failures, or requests that have not settled yet. If you need to ask again what the last action changed, run `perceive --since-action`.

If dispatch fails, read the classified `Action failure:` block instead of retrying blindly. Failures are grouped as `stale-ref`, `overlay`, `wrong-frame`, `navigation`, `dom-rewrite`, `timeout`, or `selector`, and each one includes a concrete `Next:` command such as `cdp dismiss-modal <target>`, `cdp overlay <target> @ref`, `cdp perceive <target> -C -d 8`, or `cdp status <target>`. The failed action is also recorded in `report <target>` so long sessions keep the diagnosis; successful actions record DOM, console, exception, and network evidence for later `record-actions` export.

| Command | Auto-returns |
|---------|-------------|
| `click`, `jsclick`, `clickxy`, `fill`, `type`, `press`, `select`, `scroll`, `inject`, `dismiss-modal` | action evidence + perceive diff |
| `back`, `forward`, `reload` | action evidence + full perceive |
| `viewport` (when resizing) | action evidence + perceive diff |
| `nav` | action evidence + **full perceive** (new page, not a diff) |

Example:
```
$ cdp nav <target> https://example.com
Navigated to https://example.com
---
Page: Example Store — https://example.com
Viewport: 1280×720 | Scroll: 0/3000 (0%) | ...
[WebArea] Example Store
  [banner] ...
  [main] ...
```

This eliminates the observe-act-observe loop and makes agents ~2x more efficient.

### Live injection (frontend development)

```bash
scripts/cdp.mjs inject <target> --css "body { background: #f0f0f0 }"   # inject inline CSS
scripts/cdp.mjs inject <target> --css-file https://cdn.example.com/s.css  # load external stylesheet
scripts/cdp.mjs inject <target> --js-file https://cdn.example.com/lib.js  # load external script
scripts/cdp.mjs inject <target> --remove                                  # remove all injected elements
scripts/cdp.mjs inject <target> --remove inject-2                         # remove specific injection
```

Returns an injection ID (e.g., `inject-1`) for later removal. URLs are validated — `data:`, `file:`, and cloud metadata URLs are blocked.
Use for live CSS prototyping, theme testing, or loading external libraries.

### CSS origin tracing (understand WHY it looks this way)

```bash
scripts/cdp.mjs cascade <target> ".btn-primary"                  # full cascade for element
scripts/cdp.mjs cascade <target> @3                               # cascade for @ref element
scripts/cdp.mjs cascade <target> ".btn-primary" background-color  # filter to one property
```

Shows the full CSS cascade with source file + line number:
```
background-color: #2563eb

  ✓ .btn-primary { background-color: #2563eb }
    → components.css:142
  ✗ button { background-color: #e5e7eb }  [overridden]
    → base.css:28

Inherited:
  color: #1f2937  ← body  → base.css:12
```

Use `cascade` when you need to answer "which file do I edit to change this style?" — the source location tells you exactly where to go. Inline `style=""` attributes are shown with highest priority.

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector]   # full page or element HTML
scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
scripts/cdp.mjs net     <target>               # resource timing entries
scripts/cdp.mjs click   <target> <sel|@ref>    # click (auto-returns perceive diff)
scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords (auto-returns perceive diff)
scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes
scripts/cdp.mjs press   <target> <key>         # press key (Enter/Escape/Tab auto-return perceive diff)
scripts/cdp.mjs scroll  <target> <dir|x,y> [px]  # scroll page (auto-returns perceive diff)
scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
scripts/cdp.mjs hover   <target> <sel|@ref>          # hover element (triggers :hover, tooltips)
scripts/cdp.mjs waitfor <target> <selector> [ms]      # wait for CSS selector to appear (max 5min)
scripts/cdp.mjs waitfor <target> --gone <sel|@ref> [ms]  # wait for element to DISAPPEAR (streaming end)
scripts/cdp.mjs waitfor <target> --text "str" [ms]   # wait for text to appear on page (max 5min)
scripts/cdp.mjs waitfor <target> --text "str" --scope ".reply" 120000  # scoped text wait
scripts/cdp.mjs wait    <target> 30000                 # agent-safe delay; use instead of shell sleep
scripts/cdp.mjs fill    <target> <sel|@ref> <text>     # clear field + type text (form filling)
scripts/cdp.mjs fill    <target> --react <sel|@ref> <text>  # React-controlled input value setter + input/change events
scripts/cdp.mjs select  <target> <selector> <value>    # select option (auto-returns perceive diff)
scripts/cdp.mjs styles  <target> <selector>            # computed styles (meaningful props only)
scripts/cdp.mjs text    <target> [selector]              # clean text — optional CSS selector to scope
scripts/cdp.mjs table   <target> [selector]            # full table data (tab-separated, no row limit)
scripts/cdp.mjs cookies <target>                       # list cookies for current page
scripts/cdp.mjs cookieset <target> <cookie>            # set cookie: "name=value; domain=.example.com; secure"
scripts/cdp.mjs cookiedel <target> <name>              # delete cookie by name
scripts/cdp.mjs dialog  <target> [accept|dismiss]      # show dialog history; set auto-accept or auto-dismiss
scripts/cdp.mjs viewport <target> [WxH]               # show or set viewport (e.g. 375x812)
scripts/cdp.mjs upload  <target> <selector> <paths>    # upload file(s) to input[type=file]
scripts/cdp.mjs back    <target>                       # navigate back in browser history
scripts/cdp.mjs forward <target>                       # navigate forward in browser history
scripts/cdp.mjs reload  <target>                       # reload current page
scripts/cdp.mjs closetab <target>                      # close a browser tab
scripts/cdp.mjs netlog  <target> [--clear]             # network request log (XHR/Fetch with status + timing)
scripts/cdp.mjs throttle <target> [off|offline|slow-3g|fast-3g|lte|custom]  # emulate network conditions
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs record  <target> <ms>                    # record timeline for N ms (DOM + network + console events)
scripts/cdp.mjs record  <target> --until "dom stable"    # record until DOM settles (max 30s)
scripts/cdp.mjs record  <target> --until "network idle"  # record until no pending requests (max 30s)
scripts/cdp.mjs record  <target> --action click @5       # record while performing an action — auto-settles
                                                           # (DOM/network quiet, capped at 5s if no network, 10s otherwise).
                                                           # Add an explicit duration or --until to override the auto-settle default.
scripts/cdp.mjs checkpoint <target> --format json          # page state artifact for workflow replay/debugging
scripts/cdp.mjs restore <target> --file checkpoint.json    # restores URL/cookies/storage and clears old refs
scripts/cdp.mjs flow    <target> "<steps>"               # sequential runner; semicolon-separated steps
                                                           # e.g. flow A7BA "click @1; wait dom stable; summary; console --errors"
                                                           # wait aliases: "wait dom stable", "wait network idle"
                                                           # halts on the first failing step; output is readable, not JSON
scripts/cdp.mjs doctor                          # one-call diagnostics (Node, install, daemon state, CDP, permission)
scripts/cdp.mjs ready                           # alias of doctor; exits 1 if any check FAILs
scripts/cdp.mjs open    [url]                  # open new tab + auto-attach + auto-perceive (waits up to 60s for approval)
scripts/cdp.mjs keepalive <target> <ms>        # keep a tab daemon alive for long background work
scripts/cdp.mjs stop    [target]               # stop daemon(s)
```

### Dialog handling

The daemon auto-accepts JavaScript dialogs (alert, confirm, prompt) in the background so they don't block automation. Use `dialog` to check history or change behavior.

```bash
scripts/cdp.mjs dialog <target>              # show recent dialog history
scripts/cdp.mjs dialog <target> accept       # set auto-accept mode (default)
scripts/cdp.mjs dialog <target> dismiss      # set auto-dismiss mode
```

### Viewport emulation

Show or change the viewport size. Useful for testing responsive layouts.

```bash
scripts/cdp.mjs viewport <target>            # show current viewport size
scripts/cdp.mjs viewport <target> 375x812    # emulate iPhone viewport
scripts/cdp.mjs viewport <target> 1280x720   # desktop viewport
```

Widths ≤ 768px automatically enable mobile emulation mode.

### Cookie management

```bash
scripts/cdp.mjs cookies   <target>                                    # list all cookies
scripts/cdp.mjs cookieset <target> "name=value"                       # set simple cookie
scripts/cdp.mjs cookieset <target> "name=value; domain=.example.com; secure; httponly"  # with attributes
scripts/cdp.mjs cookiedel <target> session_id                          # delete by name
```

### File upload

Upload files to `<input type="file">` elements.

```bash
scripts/cdp.mjs upload <target> "#file-input" /path/to/file.pdf
scripts/cdp.mjs upload <target> "#file-input" /path/a.jpg,/path/b.jpg   # multiple files (comma-separated)
```

### Text extraction

```bash
scripts/cdp.mjs text <target>                  # full page text (strips scripts/styles/SVG)
scripts/cdp.mjs text <target> ".reply"         # scoped to CSS selector — much less noise
scripts/cdp.mjs text <target> "main, [role=main], #app .main"  # fallback chain
scripts/cdp.mjs text <target> --root auto "header"             # scope to app root; header falls back to banner/h1/h2
```

Returns page content as plain text. **Use the selector form** to extract specific sections (e.g. AI replies, article body) instead of drowning in sidebar/nav noise.
Use `--root auto` when a React/Vite app has repeated shell text outside the app mount; it scopes extraction to `#root`, `[data-reactroot]`, `main`, then `body`.

### Table data extraction

```bash
scripts/cdp.mjs table <target>                # all tables on page (tab-separated, no row limit)
scripts/cdp.mjs table <target> "#data-table"   # specific table by CSS selector
```

Returns full table data with no row truncation (unlike perceive which caps at 5 rows). Output is tab-separated for easy parsing.

### Browser history navigation

```bash
scripts/cdp.mjs back    <target>              # go back
scripts/cdp.mjs forward <target>              # go forward
scripts/cdp.mjs reload  <target>              # reload current page and clear observation buffers
```

`reload` clears the daemon's console, exception, navigation, and network observation buffers after the page comes back, so the next `status` starts from the fresh page.

### Tab management

```bash
scripts/cdp.mjs closetab <target>             # close a tab (daemon auto-shuts down)
```

### Network request log

```bash
scripts/cdp.mjs netlog <target>               # show captured XHR/Fetch/Document requests
scripts/cdp.mjs netlog <target> --clear        # clear the log
```

Tracks XHR, Fetch, and Document requests in the background with status codes, timing, and response sizes. Use for debugging API calls.

### Network throttling

```bash
scripts/cdp.mjs throttle <target> slow-3g       # emulate a slow mobile network
scripts/cdp.mjs throttle <target> offline       # reproduce offline/error states
scripts/cdp.mjs throttle <target> custom --latency 120 --download 256 --upload 128
scripts/cdp.mjs throttle <target>               # show the current profile
scripts/cdp.mjs throttle <target> off           # reset network conditions
```

`throttle` changes the live tab's CDP network conditions and records the profile in `report <target>`. Reset to `off` after a focused experiment so later steps do not inherit a slow or offline session.

### Cursor-interactive elements (`perceive -C`)

```bash
scripts/cdp.mjs perceive <target> -C          # include non-ARIA clickable elements
```

Finds elements that are clickable but not exposed via ARIA (e.g., `<div>` with `cursor: pointer`, `onclick` handlers, or `tabindex`). These get `@c1`, `@c2` refs. Modern SPAs often use custom clickable divs that are invisible to the standard AX tree.

### Evaluate JavaScript — async support

`eval` auto-detects `await` and wraps the expression in an async IIFE:

```bash
scripts/cdp.mjs eval <target> "await fetch('/api/data').then(r => r.json())"
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

> **Tip:** `elshot` handles coordinates automatically — no DPR conversion needed.

## Tips

- **Prefer `nav` over `open`** — `nav` reuses an already-approved tab (no prompt, no "Allow debugging?" dialog). Use `open` only when `list` is empty or the user explicitly needs multiple tabs. Even page comparisons work with a single tab — `nav` between URLs and compare perceive data from context.
- `open` **auto-attaches + auto-perceives** — it waits up to 60s for Chrome's "Allow debugging?" approval, then returns Target/Next/Then/Report hints plus the full page perception (same as `nav`). Do NOT stop to ask the user; just let the command run. After `open`, follow the printed continuation command immediately.
- Prefer `snap` over `html` for page structure — compact by default, use `snap --full` for complete tree.
- Prefer `elshot` over `shot` when verifying a specific element — it's more reliable and avoids scroll/DPR issues.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Daemons keep CDP sessions alive per tab (auto-exit after 20min idle), so only the first command per tab triggers Chrome's "Allow debugging" dialog.
- **Shell quoting**: CSS selectors like `input[type=text]` contain shell metacharacters. Always wrap in quotes: `click <t> 'input[type="text"]'`.
- **WSL2 gotcha**: Never improvise WSL2→Windows connectivity (localhost, gateway IP, port forwarding, launching Chrome from WSL). The only proven pattern: user starts Chrome on Windows, agent uses Windows-side Node.js to run the CDP script.

## Workflow Patterns

### Navigating to a URL (prefer `nav` over `open`)

`nav` **auto-returns a full perceive** of the loaded page — no separate `perceive` call needed.

1. **If you already have a target ID** (from a prior `list` or command):
   ```bash
   scripts/cdp.mjs nav <target> <url>        # navigates + auto-perceives (one call!)
   ```

2. **If no target ID yet**, run `list` first to find a reusable tab:
   ```bash
   scripts/cdp.mjs list                       # find an existing tab
   scripts/cdp.mjs nav <target> <url>         # navigates + auto-perceives
   ```

3. **Only use `open`** when `list` returned empty (no tabs at all), or the user explicitly needs simultaneous tab access. For comparing pages, use `nav` to switch between URLs in a single tab — perceive data stays in your context.

> **Why this matters:** Each tab costs one "Allow debugging?" dialog. `nav` reuses the approved session — zero dialogs. Three-site comparison via `open` + `nav` + `nav` = 1 dialog total. Three `open` commands = 3 dialogs. Always minimize tabs.

### Understanding a page (default workflow)
1. `perceive <target>` — structure + layout + console health + style anomalies + @refs
2. If needed: `elshot <target> @3` — verify visual rendering of a specific ref'd element
3. If needed: `shot <target> --annotate` — visual map of all @refs overlaid on screenshot
4. If needed: `snap <target> --full` — deeper accessibility tree detail

### Comparing pages or evaluating design quality

**Use a single tab + `nav`** — perceive output is text in your context, so you don't need both pages open simultaneously. This avoids extra "Allow debugging?" approvals.

1. `nav <target> <url-A>` — auto-returns full perceive of page A (save this in context)
2. Optionally: `elshot <target> @ref` — capture key visual sections of page A
3. `nav <target> <url-B>` — auto-returns full perceive of page B
4. Optionally: `elshot <target> @ref` — capture matching sections of page B
5. Compare the two perceive outputs + elshots from context

**Only open a second tab** if you need to interact with both pages at the same time (e.g., real-time state comparison, copying data between pages).

- Analyze from perceive data: content hierarchy, data density, style anomalies, layout organization
- **DO NOT use `shot` + `scroll`** to manually scan pages — that's just slow scanshot
- **DO NOT use `scanshot`** for comparisons — `elshot` on 3-4 key sections per page gives better targeted comparison

### Temporal observation (understanding cause and effect)

> **When to use `record` instead of `perceive --since-action` or `report`:**
>
> `perceive --since-action` shows WHAT the last action changed. `report` summarizes the action timeline so far. `record-actions` exports the actions as replay-oriented steps, `export-playwright` drafts a regression spec from the portable subset, `diff-shot` saves reviewable pixel-diff artifacts when visual fallback is needed, and `replay` executes the replayable subset. `record` shows **WHEN things changed, in what order, and what caused what** during a focused observation window.
>
> | Situation | Use `perceive --since-action` / `report` | Use `record` |
> |-----------|------------------------------------------|--------------|
> | Clicked a button, need to see result | ✅ auto-returned by `click` | Not needed |
> | Clicked Submit, page loads for 3s, need to know what happened during those 3s | ❌ only shows final state | ✅ `record --action click @5` |
> | Page is slow after navigation, need to know why | ❌ snapshot after the fact | ✅ `record <target> 5000` |
> | Need to know when page became stable after SPA route change | ❌ | ✅ `record --until "dom stable"` |
> | Debugging intermittent console errors | ❌ console buffer loses timing context | ✅ `record <target> 10000` — correlated timeline |
> | Verifying that API call triggers correct DOM update | ❌ can't see network+DOM correlation | ✅ `record --action click @ref` — shows POST → DOM update sequence |

```
# See cause and effect of clicking Submit:
scripts/cdp.mjs record <target> --action click @5

# Watch what happens during page load:
scripts/cdp.mjs nav <target> <url>
scripts/cdp.mjs record <target> --until "dom stable"

# Passive: what's happening on this page right now?
scripts/cdp.mjs record <target> 5000
```

**Rule of thumb:** If you need to answer "what happened?" or "why did that take so long?", use `record`. If you need to answer "what does it look like now?", use `perceive`.

### Debugging a broken page
1. `perceive <target>` — structure + console errors + style anomalies in one call
2. `console <target> --errors` — detailed error messages + stack traces if needed
3. If the problem involves timing (slow load, delayed render, intermittent error): `record <target> 5000` to capture a timeline
4. Check perceive style hints for visual issues first; `elshot` only for subjective visual quality
5. `styles <target> ".broken-element"` — full computed styles if needed

### Form automation
1. `perceive <target>` — understand form structure and get @refs for fields
2. Use `batch` with pipe syntax for the entire fill+submit in one call:
   ```bash
   batch <target> 'fill @3 user@example.com | fill @5 password123 | click @7'
   ```
3. The final `click` auto-returns perceive diff showing the result
4. For parallel fills (independent fields), add `--parallel`:
   ```bash
   batch <target> --parallel 'fill @3 user@example.com | fill @5 password123'
   ```
   Then `click <target> @7` to submit.

### Data extraction
1. `text <target> [selector]` — get readable text (use selector to scope, e.g. `text <t> ".content"`)
2. `table <target>` — get full table data (no 5-row truncation)
3. `table <target> "#specific-table"` — extract specific table

### Cross-tab parallel operations

When you need to perform the same action across multiple tabs (e.g., send a prompt to 3 AI chatbots), use **parallel Bash calls** — each CDP command targets a different daemon, so they run concurrently:

```bash
# Three parallel fills + submits (run as separate Bash calls in one message)
scripts/cdp.mjs fill FFCC @3 "What is 2+2?" && scripts/cdp.mjs press FFCC Enter
scripts/cdp.mjs fill E701 @5 "What is 2+2?" && scripts/cdp.mjs press E701 Enter
scripts/cdp.mjs fill D5D0 @2 "What is 2+2?" && scripts/cdp.mjs press D5D0 Enter
```

Then wait for all responses with parallel `waitfor --text`:
```bash
scripts/cdp.mjs waitfor FFCC --text "answer" 120000
scripts/cdp.mjs waitfor E701 --text "answer" 120000
scripts/cdp.mjs waitfor D5D0 --text "answer" 120000
```

### Interacting with AI chatbots (ChatGPT, Gemini, Claude, etc.)

**Sending a prompt:**
1. `perceive <target> -x "nav, aside"` — see input area without sidebar noise
2. `fill <target> @ref "your prompt here"` — fill the input field
3. `click <target> @sendButton` or `press <target> Enter` — submit (auto-returns perceive diff)

**Waiting for the response (DO NOT use `sleep`):**

Read the perceive diff from step 3 — it shows what appeared (e.g., a stop button, loading spinner). Use `waitfor --gone` on that element:
```bash
# The diff showed: + [button] "Stop generating" @19
scripts/cdp.mjs waitfor <target> --gone @19 120000    # wait for stop button to disappear = AI done
```
- `--gone` with `@ref` is the most reliable — zero keyword guessing, zero site-specific selectors
- The perceive diff tells you exactly what to wait for
- Fallback: `waitfor --text "keyword" --scope "main" 120000` if no obvious indicator

**Extracting the response (DO NOT use full-page `text`):**
```bash
scripts/cdp.mjs text <target> "main"              # scope to main content area
```
- **Always scope `text` with a CSS selector** — full-page text drowns the answer in sidebar noise
- Use `perceive -x "nav, aside"` to discover the right selector if `"main"` is too broad

**Multi-chatbot parallel workflow:**
1. `open` first chatbot → `nav` to others (single-tab per site, minimize Allow dialogs)
2. Send prompts via parallel Bash calls (each targets a different tab daemon)
3. Wait for all responses via parallel `waitfor --gone` or `waitfor --text` calls
4. Extract responses via parallel `text <target> <selector>` calls

### Debugging API calls
1. `perceive <target>` — check page state
2. `netlog <target>` — see recent XHR/Fetch requests with status codes
3. `throttle <target> slow-3g` or `throttle <target> offline` — reproduce slow-network or offline behavior when relevant
4. `console <target> --errors` — check for errors
5. If you need to see the full request→response→DOM update chain: `record <target> --action click @submitBtn` — captures the API call, its response, and resulting DOM mutations in one timeline
6. `throttle <target> off` — reset before handing the session back

### Performance investigation
1. `nav <target> <url>` — navigate to the page
2. `throttle <target> fast-3g|slow-3g` — make network-sensitive loading deterministic when needed
3. `record <target> --until "dom stable"` — capture the full load lifecycle
4. Read the timeline: which API calls are slow? When do DOM mutations peak? When does the page settle?
5. For specific interactions: `record <target> --action click @ref` — measure cause-to-effect latency
6. `throttle <target> off` — reset the live tab

### Responsive testing
1. `perceive <target>` — baseline at current viewport
2. `viewport <target> 375x812` — switch to mobile (auto-returns perceive diff!)
3. `viewport <target> 1280x720` — switch back to desktop (auto-returns perceive diff!)

### Visual bug investigation
1. `perceive <target>` — structure + layout positions + style hints
2. Check perceive for style anomalies (`bg:`, `bold`, `color:` annotations)
3. `cascade <target> ".suspect" background-color` — trace WHERE the style comes from (file + line)
4. `styles <target> ".suspect"` — full computed CSS if perceive hints aren't enough
5. `elshot <target> ".suspect"` — only if you need to see the actual rendered pixels

### CSS debugging ("why does this look wrong?")
1. `perceive <target>` — identify the element with the issue
2. `cascade <target> @ref` — see the full cascade: which rule won, which are overridden, source locations
3. `cascade <target> @ref background-color` — focus on one property if the cascade is large
4. Read the source file at the line number shown → make the fix
5. `inject <target> --css ".fix { background: red }"` — test the fix live before editing the file
6. `inject <target> --remove` — clean up when done

> **Key insight:** `cascade` answers "which file, which line" — the single most common CSS debugging question. `styles` shows computed values but not origin. `cascade` shows origin.

### Live CSS prototyping
1. `perceive <target>` — understand the page structure
2. `inject <target> --css "body { --primary: #2563eb }"` — inject design token changes
3. `perceive <target> --diff` or `elshot <target> @ref` — verify the visual effect
4. Iterate: `inject <target> --remove` → `inject <target> --css "..."` for each revision
5. Once satisfied, apply the CSS to the actual source file

## Long-session / game / animation recipes

### Stale `@ref` lifecycle

Refs are short-lived handles assigned by `perceive`. They become invalid when:

- the page navigates or fully reloads (Vite HMR included),
- a large DOM rewrite replaces the labelled element,
- the daemon restarts (idle timeout, crash, or fresh `_daemon` spawn).

**No automatic remap.** When a ref goes stale, the tool reports the error and
clears the entry — it does **not** try to guess "the new equivalent" element,
because that decision needs page semantics the daemon does not have. The agent
must re-perceive (or pivot to a stable selector) and pick the next handle.

The error you'll see is classified by cause:

- `No refs have been assigned in this daemon yet.` — daemon-start; just run `perceive`.
- `Refs were cleared because the page navigated/reloaded after the last perceive (e.g. Vite HMR or in-app routing). Run "perceive" to refresh refs, or use a stable CSS selector for long loops.` — top-level navigation invalidation.
- `Refs were invalidated by DOM changes after the last perceive. Run "perceive" again, or use a stable CSS selector in batch/loops.` — backend node could not be re-resolved (large rewrite).

Honour the wording — for any loop longer than 1–2 immediate actions, prefer a stable CSS selector like `input[placeholder*="look"]` over `@31`. `repeat`/`batch`/`flow` deliberately do not retry around stale refs for the same reason. `repeat` may wrap `flow` for multi-step turns, but it still cannot wrap `repeat`, `batch`, or `stop`.

### Wait primitives for combat / chat / animations

```bash
# 1) Multi-keyword OR ("won, lost, escaped"):
cdp waitfor <t> --any-of "戰鬥勝利|戰敗|逃跑成功" 60000 --scope ".combat-log"

# 2) Wait until DOM under a selector stops changing for 3s (event log settle):
cdp waitfor <t> --selector-stable ".combat-log" 3000 60000

# 3) Capture cause-and-effect timeline around an action:
cdp record <t> --action click @5 --until "dom stable"
```

### Bounded loops — `repeat`

```bash
cdp repeat <t> 5 press space          # advance 5 dialogue beats; halt on first failure
cdp repeat <t> 8 --continue press c   # fire shortcut 8 times, ignore transient misses
cdp repeat <t> 3 click @attackBtn     # 3 combat turns; fail-fast preserves diagnosability

# Multi-step body — wrap a flow as the inner command (one-level nesting OK):
cdp repeat <t> 3 flow "click button[data-act='attack']; wait dom stable; text .combat-log"
```

`repeat` caps `<count>` at 50 and refuses to wrap `repeat`/`batch`/`stop` so an
agent loop cannot recurse or corrupt the daemon IPC stream. `flow` *is* allowed
as the inner command, so a single "turn" can be `click → wait → check log` and
the outer `repeat` halts on the first turn that fails. Default behaviour is
fail-fast — the first failing iteration halts the loop and prints which
iteration tripped, so you can re-perceive and adjust before the next attempt.
Use `--continue` only when later iterations are independent of the failing one
(e.g. retrying through transient input misses on a hot keyboard handler).

**Refs and `repeat`**: refs are not auto-remapped between iterations. If iteration
1 mutates the DOM enough to invalidate `@5`, iteration 2 will fail with a
classified `Unknown ref` error. Switch to a stable selector
(`button[data-act='attack']`) for any loop that survives DOM rewrites.

### JS-fallback click — `jsclick` / `click --js`

```bash
cdp jsclick <t> @17                                       # @ref form
cdp click   <t> --js "button[data-action='confirm']"     # CSS form
```

Use this when the realistic mouse path (CDP `Input.dispatchMouseEvent`) is blocked:
- Transparent overlay covers the button but does not consume `el.click()`.
- Page applies a CSS transform/scale that breaks viewport-to-content hit testing.
- A Vue/React component listens only for synthetic clicks bubbled through its root.

`jsclick` calls `HTMLElement.click()` (falling back to `dispatchEvent(new MouseEvent('click'))`).
The default `click` is still preferred — it produces realistic event sequences
that pass through `:active`/`:hover`/focus rings — but `jsclick` is the right
escape hatch when you can prove the mouse path is the blocker.

### React-controlled inputs — `fill --react`

```bash
cdp fill <t> --react "input[name='message']" "hello"
cdp fill <t> --react @12 "hello"
```

Use this when normal `fill` appears to type but the app state does not update.
It uses the native value setter and dispatches `input` plus `change`, which is
the fallback controlled React inputs usually need. Keep normal `fill` as the
default because it exercises the browser's text input path.

### Safe transport for CJK / shell-hostile JS — `eval64` / `eval --b64`

```bash
B64=$(printf '%s' 'document.title.includes("戰鬥勝利")' | base64)
cdp eval64 <t> "$B64"
cdp eval   <t> --b64 "$B64"
```

Shell quoting mangles Unicode bytes inconsistently across `bash`, `zsh`, and PowerShell.
Encoding the expression as base64 sidesteps the entire quoting layer and produces a
lossless round-trip for CJK/RTL/control-character expressions. The decoder
validates the input — non-base64 garbage raises a clear error rather than
silently evaluating part of the payload.

### Long async page work

```bash
cdp call <t> "async () => window.app.getState()"
cdp eval <t> --fire-and-forget "setInterval(() => window.tick?.(), 1000)"
cdp keepalive <t> 3600000
cdp wait <t> 30000
cdp wait 30000
```

Use `call` when the result matters and `eval --fire-and-forget` only for
intentional background work. Fire-and-forget eval extends the daemon keepalive
by one hour; `keepalive` can extend it explicitly. Prefer `cdp wait` to shell
`sleep` when long sleeps are blocked by agent policy.

### Game / MUD sequence capture — putting it all together

```bash
# 1. Discover the page once
cdp perceive <t> -C -d 8 -x "nav, aside"

# 2. Capture the cause-and-effect of a single combat action
cdp record <t> --action click @5 --until "dom stable"

# 3. Wait for the human-language outcome line
cdp waitfor <t> --any-of "戰鬥勝利|戰敗|逃跑成功" 60000 --scope ".combat-log"

# 4. Pull the post-action log content (use a stable selector, not @ref)
cdp text <t> ".combat-log"

# 5. For multi-turn drills where each turn is independent:
cdp repeat <t> 3 click "button[data-act='attack']"
```

This sequence consistently captures: structure → action → settle → outcome →
extracted text, in five short calls without any `sleep`-based polling.

### Modal dismissal that does NOT fire underlying shortcuts

```bash
cdp dismiss-modal <t>   # clicks visible close button, falls back to Escape
```

The reviewer used `press Space` to dismiss an MOTD and accidentally triggered the underlying game's `space` hotkey. `dismiss-modal` only sends Escape if no close button is found — `Space` is never used.

### Long event-log perception

```bash
cdp perceive <t> -i --keep-refs --last 20   # keep all refs + last 20 text rows
cdp perceive <t> -s ".combat-log" -d 6      # scope to the log subtree
```

`--last N` truncates only static-text / paragraph rows; landmark and interactive `@ref` lines are always preserved. The truncation is priority-aware: high-signal text such as errors, failures, required/invalid validation, warnings, saved/success/submitted results is kept even if it is older than the last N rows. `perceive --since-action` applies the same priority so important new text appears as diff evidence instead of being collapsed into a generic text-count summary.

### Screenshot in scripts

```bash
cdp shot <t> /tmp/x.png --quiet     # only the saved path is printed (good for `head -1`)
cdp shot <t> /tmp/x.png             # default: path on line 1, short DPR hint after
cdp shot <t> /tmp/x.png --verbose   # path + full coordinate-mapping tutorial
cdp shot <t> --annotate             # red-box overlay using the most recent perceive's @refs
```

### `@c` / cursor-interactive elements

```bash
cdp perceive <t> -C   # also lists non-ARIA clickables (cursor:pointer, onclick, tabindex)
```

These get `@c1`, `@c2`… handles. Useful for SPAs that wrap clickable behaviour on a `<div>` instead of a `<button>`.

### Vite / HMR

When Vite HMRs a route, `Page.frameNavigated` fires and the daemon clears its ref map automatically. The next `@ref` you try will produce the navigation-classified error. Just re-run `perceive` and continue.

## Dogfood Benchmark

Before making performance or adoption claims, run the live Killer Path benchmark:

```bash
npm run benchmark:killer
npm run benchmark:killer -- --json
```

It launches a disposable debug browser against the local smoke page and measures `doctor -> list -> perceive -> act -> since-action evidence -> report`: command calls, total time, first useful observation time, estimated output tokens, useful observation tokens, auto-evidence actions, verification calls saved, report timeline presence, stale-ref recovery, and differentiator probes for modal/overlay detection, frame refs, CSS source tracing, and HMR/SPA DOM-update diff success/time.

## Source

**Upstream**: [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) (v1.0.1) — locally modified with Windows support, background observation, and additional commands.
