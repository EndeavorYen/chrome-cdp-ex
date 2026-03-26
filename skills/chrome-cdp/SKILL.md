---
name: chrome-cdp
description: "Your EYES into the user's live Chrome browser. This skill lets you SEE and INTERACT with the user's actual browser — their open tabs, logged-in sessions, and live page state. You MUST use this whenever the user's request involves browser content in ANY way.\n\nTRIGGER THIS SKILL when the user:\n- References pages they have open: '我開了頁面', 'I have X open', '瀏覽器上的', 'my tabs'\n- Asks you to look at, compare, or analyze anything in their browser: '比較頁面', '哪個比較好', '看看這個頁面', 'compare these pages', 'which looks better'\n- Mentions UI/visual analysis of live pages: 'dashboard', '設計品質', 'UI', 'layout', '好不好看', 'design quality'\n- Asks for screenshots or page inspection: 截圖, screenshot, inspect, debug, check the page\n- Refers to 'the page', 'the browser', 'my tab', '網頁', '頁面' in any context\n- Mentions console errors, page state, or anything requiring browser access\n\nCRITICAL: NEVER say '我無法看到你的瀏覽器' or ask users to paste screenshots. You CAN see their browser through this skill. Use `list` to discover open tabs, then `perceive` or `shot`/`scanshot` to see page content.\n\nDo NOT use Playwright — it launches an isolated browser without the user's login state, cookies, or open tabs."
---

# Chrome CDP

## When invoked directly (`/chrome-cdp`)

**Take action immediately — do not just read this document.**

1. Run `scripts/cdp.mjs list` to discover open tabs
2. Show the user what tabs are available
3. If the user's prior message references specific pages or content, match them to tabs and run `scripts/cdp.mjs perceive <target>` on the relevant tab(s)
4. If no specific request, ask the user which tab to inspect

Connects to the user's **existing Chrome browser** via CDP WebSocket. No Puppeteer, no new browser instance — works with the tabs, login sessions, and page state the user already has open. Only use Playwright when the user explicitly wants a fresh isolated browser for testing.

## Observation Strategy — Perceive First, Screenshot Last

> **Three-tier perception model:**
>
> | Tier | Command | When to use | Output |
> |------|---------|-------------|--------|
> | 1. **Perceive** | `perceive` | **Default starting point** for any page inspection | AX tree + layout + style hints (~200-400 tokens) |
> | 2. **Targeted visual** | `elshot <selector>` | Verify visual rendering of a **specific element** | Clipped PNG of one element |
> | 3. **Full visual** | `scanshot` | Last resort — pixel-level audit of **entire page** | Multiple viewport-sized PNGs (expensive!) |
>
> Always start with `perceive`. See **"Verifying changes after actions"** below for when to use each tier.

### Observation workflow

```
1. perceive <target>          ← ALWAYS start here
   ↓ understand structure, content, layout
2. snap <target> --full       ← if you need deeper AX tree detail
   OR elshot <target> <sel>   ← if you need visual verification of ONE element
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

**Key insight:** `perceive` now includes **style anomaly detection** on table cells. If a cell has a non-default background color, bold text, or unusual text color compared to its column siblings, perceive annotates it directly (e.g., `[cell] 70.0%  bg:rgb(255,200,200)  bold`). You don't need a screenshot to verify conditional styling.

## Prerequisites

- Chrome (or Chromium, Brave, Edge, Vivaldi) with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch. This is sufficient — do NOT suggest restarting Chrome with `--remote-debugging-port`.
- Node.js 22+ (uses built-in WebSocket)
- If your browser's `DevToolsActivePort` is in a non-standard location, set `CDP_PORT_FILE` to its full path

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
node ~/.claude/plugins/.../skills/chrome-cdp/scripts/cdp.mjs <command> [args]

# WSL2 (use Windows Node.js):
"$NODE_WIN" ~/.claude/plugins/.../skills/chrome-cdp/scripts/cdp.mjs <command> [args]
```
On first use, always start with `list` to verify connectivity and discover available tabs.

**Interpreting `list` output**:
```
A7BA5C64  My Page Title    https://example.com/page
F39B10E2  Another Tab      https://other.site/path
```
- Each line: `<8-char target ID>  <title>  <url>`. Use the target ID (e.g. `A7BA5C64`) for subsequent commands.
- **Empty output (exit 0)** = no tabs available. This is normal — either Chrome has no open tabs, or Chrome has not yet approved debugging. Tell the user: "Please open a tab in Chrome and approve the 'Allow debugging' dialog, then I'll retry." Do NOT suggest `--remote-debugging-port` restarts.
- **Error output** = connection problem. Check prerequisites.

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list` (e.g. `A7BA5C64`). The CLI rejects ambiguous prefixes.

### Perceive page (recommended starting point)

```bash
scripts/cdp.mjs perceive <target>              # full page perception with @ref indices + coordinates
scripts/cdp.mjs perceive <target> --diff       # show only changes since last perceive
scripts/cdp.mjs perceive <target> -s "#main"   # scope to CSS selector subtree
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
```

After performing an action (click, fill, etc.), use `perceive --diff` to see exactly what changed in the page structure. Shows added and removed AX tree lines. Much more token-efficient than a full re-perceive when verifying an action's effect.

### Accessibility tree snapshot

```bash
scripts/cdp.mjs snap <target>          # compact (default) — filters noise
scripts/cdp.mjs snap <target> --full   # complete AX tree with all nodes
```

Use `snap` when you need just the accessibility tree without layout metadata (e.g., when `perceive` has already given you layout context and you need deeper AX detail).

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
scripts/cdp.mjs scanshot <target>         # segmented full-page (multiple viewport-sized images)
scripts/cdp.mjs fullshot <target> [file]  # single full-page image (may be tiny on long pages)
```

- **`shot`** — viewport only. Use when you need the currently visible area as pixels.
- **`scanshot`** — scrolls through and captures multiple viewport-sized images with 10% overlap. Use when you need pixel-level verification of an entire page.
- **`fullshot`** — single image of entire page. **Do NOT use for analysis** — on long pages text becomes unreadably small. Only for non-AI consumption.

### Evaluate JavaScript

```bash
scripts/cdp.mjs eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Page status & console

The daemon buffers console output and exceptions in the background from the moment it starts. Use these commands to query the buffer.

```bash
scripts/cdp.mjs status  <target>                  # page state + new console/exception entries
scripts/cdp.mjs summary <target>                  # token-efficient page overview (~100 tokens)
scripts/cdp.mjs console <target> [--all|--errors] # console buffer (default: unread only)
```

> **Agent tip:** `perceive` already includes summary + console health. Use `status` or `console` only when you need to check for **new** console entries after an action.

### Batch commands (reduce IPC overhead)

```bash
scripts/cdp.mjs batch <target> '[{"cmd":"click","args":["@3"]},{"cmd":"perceive","args":["--diff"]}]'
```

Executes multiple commands in a single IPC call. Returns a JSON array of results. Useful for form-filling workflows where you need to fill multiple fields and verify the result in one round trip.

### Action feedback (automatic)

`click`, `clickxy`, `press` (Enter/Escape/Tab), and `select` **automatically wait for DOM to settle and return a perceive diff**. No need to manually run `perceive --diff` after these actions. Example:

```
$ cdp click <target> @3
Clicked <BUTTON> "Submit" (@3)
---
Page: Example — https://example.com
... (perceive diff showing what changed)
```

This eliminates the observe-act-observe loop and makes agents ~2x more efficient.

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector]   # full page or element HTML
scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
scripts/cdp.mjs net     <target>               # resource timing entries
scripts/cdp.mjs click   <target> <sel|@ref>    # click (auto-returns perceive diff)
scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords (auto-returns perceive diff)
scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes
scripts/cdp.mjs press   <target> <key>         # press key (Enter/Escape/Tab auto-return perceive diff)
scripts/cdp.mjs scroll  <target> <dir|x,y> [px]  # scroll page (down/up/left/right; default 500px)
scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
scripts/cdp.mjs hover   <target> <sel|@ref>          # hover element (triggers :hover, tooltips)
scripts/cdp.mjs waitfor <target> <selector> [ms]      # wait for element to appear (default 10s)
scripts/cdp.mjs fill    <target> <sel|@ref> <text>     # clear field + type text (form filling)
scripts/cdp.mjs select  <target> <selector> <value>    # select option (auto-returns perceive diff)
scripts/cdp.mjs styles  <target> <selector>            # computed styles (meaningful props only)
scripts/cdp.mjs text    <target>                       # clean text content (strips scripts/styles/SVG)
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
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs open    [url]                  # open new tab — AVOID: triggers Chrome "Allow debugging?" prompt. Prefer nav instead
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
scripts/cdp.mjs text <target>                 # clean readable text (strips scripts/styles/SVG)
```

Returns page content as plain text — useful for reading articles, searching for text, or comparing content without AX tree overhead.

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
scripts/cdp.mjs reload  <target>              # reload current page
```

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

- **Prefer `nav` over `open`** — `open` creates a new tab that requires Chrome's "Allow debugging?" approval (user must click). `nav` reuses an already-approved tab — **no prompt, no waiting**. Only use `open` when the user explicitly needs multiple tabs open simultaneously.
- After `open`, use the returned target ID directly (e.g. `Opened new tab: A7BA5C64`) — no need for another `list` call.
- Prefer `snap` over `html` for page structure — compact by default, use `snap --full` for complete tree.
- Prefer `elshot` over `shot` when verifying a specific element — it's more reliable and avoids scroll/DPR issues.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Daemons keep CDP sessions alive per tab (auto-exit after 20min idle), so only the first command per tab triggers Chrome's "Allow debugging" dialog.
- **Shell quoting**: CSS selectors like `input[type=text]` contain shell metacharacters. Always wrap in quotes: `click <t> 'input[type="text"]'`.
- **WSL2 gotcha**: Never improvise WSL2→Windows connectivity (localhost, gateway IP, port forwarding, launching Chrome from WSL). The only proven pattern: user starts Chrome on Windows, agent uses Windows-side Node.js to run the CDP script.

## Workflow Patterns

### Navigating to a URL (prefer `nav` over `open`)

When the user asks you to visit/open a URL:

1. **If you already have a target ID** (from a prior `list` or command):
   ```bash
   scripts/cdp.mjs nav <target> <url>        # reuse existing tab — no Allow prompt!
   scripts/cdp.mjs perceive <target>          # inspect the loaded page
   ```

2. **If no target ID yet**, run `list` first to find a reusable tab:
   ```bash
   scripts/cdp.mjs list                       # find an existing tab
   scripts/cdp.mjs nav <target> <url>         # navigate it — no Allow prompt!
   scripts/cdp.mjs perceive <target>          # inspect
   ```

3. **Only use `open` when the user needs multiple tabs** open at the same time (e.g. comparing two pages side by side). Each `open` triggers Chrome's "Allow debugging?" dialog which requires user interaction.

> **Why this matters:** `nav` reuses an already-approved debugging session — instant, no user interaction needed. `open` creates a brand new tab that Chrome hasn't approved for debugging yet, forcing the user to click "Allow" every time. For most workflows, `nav` is strictly better.

### Understanding a page (default workflow)
1. `perceive <target>` — structure + layout + console health + style anomalies + @refs
2. If needed: `elshot <target> @3` — verify visual rendering of a specific ref'd element
3. If needed: `shot <target> --annotate` — visual map of all @refs overlaid on screenshot
4. If needed: `snap <target> --full` — deeper accessibility tree detail

### Comparing pages or evaluating design quality
1. `perceive` **both** pages — compare structure, layout, style hints (colors, bold, font sizes)
2. `elshot` **specific sections** only if perceive shows identical structure but you need subjective aesthetic comparison
3. Analyze from perceive data: content hierarchy, data density, style anomalies, layout organization
4. **DO NOT use `shot` + `scroll`** to manually scan pages — that's just slow scanshot
5. **DO NOT use `scanshot`** for comparisons — `elshot` on 3-4 key sections per page gives better targeted comparison

### Debugging a broken page
1. `perceive <target>` — structure + console errors + style anomalies in one call
2. `console <target> --errors` — detailed error messages + stack traces if needed
3. Check perceive style hints for visual issues first; `elshot` only for subjective visual quality
4. `styles <target> ".broken-element"` — full computed styles if needed

### Form automation
1. `perceive <target>` — understand form structure and get @refs for fields
2. `fill <target> @3 "user@example.com"` — fill input by @ref
3. `fill <target> @5 "password123"` — fill another field
4. `click <target> @7` — submit (auto-returns perceive diff showing result!)
5. No need for manual `perceive --diff` — click already includes it
6. For bulk operations, use `batch`:
   ```bash
   batch <target> '[{"cmd":"fill","args":["@3","user@example.com"]},{"cmd":"fill","args":["@5","pass"]},{"cmd":"click","args":["@7"]}]'
   ```

### Data extraction
1. `text <target>` — get all readable text (for search or comparison)
2. `table <target>` — get full table data (no 5-row truncation)
3. `table <target> "#specific-table"` — extract specific table

### Debugging API calls
1. `perceive <target>` — check page state
2. `netlog <target>` — see recent XHR/Fetch requests with status codes
3. `console <target> --errors` — check for errors

### Responsive testing
1. `perceive <target>` — baseline at current viewport
2. `viewport <target> 375x812` — switch to mobile
3. `perceive <target> --diff` — see what changed in layout
4. `viewport <target> 1280x720` — switch back to desktop

### Visual bug investigation
1. `perceive <target>` — structure + layout positions + style hints
2. Check perceive for style anomalies (`bg:`, `bold`, `color:` annotations)
3. `styles <target> ".suspect"` — full computed CSS if perceive hints aren't enough
4. `elshot <target> ".suspect"` — only if you need to see the actual rendered pixels

## Source

**Upstream**: [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) (v1.0.1) — locally modified with Windows support, background observation, and additional commands.
