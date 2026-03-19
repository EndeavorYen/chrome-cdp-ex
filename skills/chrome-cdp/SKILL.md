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

> **CRITICAL — Read this before any page inspection.**
>
> Use **structured text** (accessibility tree, layout metadata) as the primary way to understand pages. Screenshots are a **secondary verification tool**, not the default. This approach is more reliable, more token-efficient, and avoids common screenshot pitfalls (wrong scroll position, DPR mismatch, tiny text on long pages).
>
> **Three-tier perception model:**
>
> | Tier | Command | When to use | Output |
> |------|---------|-------------|--------|
> | 1. **Perceive** | `perceive` | **Default starting point** for any page inspection | Summary + AX tree + visual layout (text, ~200-400 tokens) |
> | 2. **Targeted visual** | `elshot <selector>` | Need to verify visual rendering of a **specific element** | Clipped PNG of one element (auto scrolls, no DPR confusion) |
> | 3. **Full visual** | `scanshot` | Last resort — pixel-level audit of **entire page** | Multiple viewport-sized PNGs (expensive!) |
>
> **DO NOT** start with `shot` or `scanshot`. Always start with `perceive` to understand the page structure and content. Only use `elshot` when you specifically need to verify visual appearance of a component. **`scanshot` should almost never be needed** — if you find yourself reaching for it, ask: "Can I answer this with `elshot` on 2-3 specific sections instead?"

### Why perceive-first is better

- **No scroll position errors** — `perceive` reads the DOM directly, not viewport pixels
- **No DPR confusion** — text output doesn't need coordinate conversion
- **Token-efficient** — ~200-400 tokens vs thousands for an image
- **Semantically richer** — roles, labels, states, values (not just pixels)
- **Spatial awareness** — layout section includes bounding boxes for structural elements
- **Reliable for text content** — LLM reads text perfectly; vision can misread screenshots

### Observation workflow

```
1. perceive <target>          ← ALWAYS start here
   ↓ understand structure, content, layout
2. snap <target> --full       ← if you need deeper AX tree detail
   OR elshot <target> <sel>   ← if you need visual verification of ONE element
3. scanshot <target>          ← ONLY if you need full-page visual verification
```

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
scripts/cdp.mjs perceive <target>    # summary + accessibility tree + visual layout metadata
```

Returns a single **enriched accessibility tree** that combines semantic structure with inline visual annotations:
- **Page header**: title, URL, viewport size, scroll position, console health, interactive element counts
- **Enriched AX tree**: semantic roles and labels (from accessibility tree) with **inline layout annotations** on landmark/structural nodes — height, background color, font size, display mode, and viewport visibility (↑above fold / ↓below fold)

Example output:
```
Page: Example Store — https://example.com/store
Viewport: 1280×720 | Scroll: 500/3000 (17%) | Focused: none
Interactive: 12 a, 3 button, 2 input[text]
Console: 2 errors, 1 warning

[WebArea] Example Store
  [banner]  ↕80px  bg:rgb(26, 26, 46)  ↑above fold
    [navigation] Main Menu
      [link] Home
      [link] Products
  [main]  ↕2920px
    [heading] Welcome to Our Store  36px 700
    [img] Hero Banner  ↕400px
    [region] Product Grid  grid  gap:20px
      [link] Product 1 — $29.99
      [link] Product 2 — $49.99
  [contentinfo]  ↕160px  bg:rgb(26, 26, 46)  ↓below fold
    [link] Privacy Policy
```

Hierarchy comes from the accessibility tree (always correct). Layout annotations are added only to landmark/structural nodes (banner, navigation, main, heading, img, etc.) — not every element. This is **the most efficient way** to understand a page. Use it before any screenshots.

### Accessibility tree snapshot

```bash
scripts/cdp.mjs snap <target>          # compact (default) — filters noise
scripts/cdp.mjs snap <target> --full   # complete AX tree with all nodes
```

Use `snap` when you need just the accessibility tree without layout metadata (e.g., when `perceive` has already given you layout context and you need deeper AX detail).

### Element screenshot (targeted visual verification)

```bash
scripts/cdp.mjs elshot <target> <selector>   # screenshot of a specific element
```

- Automatically scrolls the element into view and clips the capture to its bounding box
- Adds 8px padding around the element for context
- **No DPR confusion** — the clip is in CSS coordinates, handled by CDP
- **No scroll position errors** — scrollIntoView + clip guarantees the right content
- Use when you need to verify visual appearance of a specific component

> **Prefer `elshot` over `shot`** when you need to visually verify a specific element. It's more reliable and captures exactly what you need.

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

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector]   # full page or element HTML
scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
scripts/cdp.mjs net     <target>               # resource timing entries
scripts/cdp.mjs click   <target> <selector>    # click element by CSS selector
scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
scripts/cdp.mjs press   <target> <key>         # press key (Enter, Tab, Escape, Backspace, Space, Arrow*)
scripts/cdp.mjs scroll  <target> <dir|x,y> [px]  # scroll page (down/up/left/right; default 500px)
scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
scripts/cdp.mjs hover   <target> <selector>          # hover element (triggers :hover, tooltips)
scripts/cdp.mjs waitfor <target> <selector> [ms]      # wait for element to appear (default 10s)
scripts/cdp.mjs fill    <target> <selector> <text>     # clear field + type text (form filling)
scripts/cdp.mjs select  <target> <selector> <value>    # select <select> option by value
scripts/cdp.mjs styles  <target> <selector>            # computed styles (meaningful props only)
scripts/cdp.mjs cookies <target>                       # list cookies for current page
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs open    [url]                  # open new tab (each triggers Allow prompt)
scripts/cdp.mjs stop    [target]               # stop daemon(s)
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

> **Tip:** `elshot` handles coordinates automatically — no DPR conversion needed.

## Tips

- Prefer `snap` over `html` for page structure — compact by default, use `snap --full` for complete tree.
- Prefer `elshot` over `shot` when verifying a specific element — it's more reliable and avoids scroll/DPR issues.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Daemons keep CDP sessions alive per tab (auto-exit after 20min idle), so only the first command per tab triggers Chrome's "Allow debugging" dialog.
- **Shell quoting**: CSS selectors like `input[type=text]` contain shell metacharacters. Always wrap in quotes: `click <t> 'input[type="text"]'`.
- **WSL2 gotcha**: Never improvise WSL2→Windows connectivity (localhost, gateway IP, port forwarding, launching Chrome from WSL). The only proven pattern: user starts Chrome on Windows, agent uses Windows-side Node.js to run the CDP script.

## Workflow Patterns

### Understanding a page (default workflow)
1. `perceive <target>` — get complete page understanding (structure + layout + console health)
2. If needed: `elshot <target> ".specific-element"` — verify visual rendering of a component
3. If needed: `snap <target> --full` — deeper accessibility tree detail

### Comparing pages or evaluating design quality
1. `perceive` **both** pages — compare structure, information architecture, component organization
2. `elshot` **specific sections** on each page for visual comparison — e.g., header area, status cards, data tables, navigation
3. Analyze from perceive data: content hierarchy, data density, alert presentation, layout organization
4. Analyze from elshot images: typography, color usage, spacing, visual polish
5. **DO NOT use `scanshot`** for comparisons — `elshot` on 3-4 key sections per page gives better targeted comparison than 8+ full-page screenshots

### Debugging a broken page
1. `perceive <target>` — check structure + console errors in one call
2. `console <target> --errors` — detailed error messages + stack traces if needed
3. `elshot <target> ".broken-element"` — visual verification of the problematic area
4. `styles <target> ".broken-element"` — check computed styles

### Form automation
1. `perceive <target>` — understand form structure and field names
2. `fill <target> "#email" "user@example.com"` — fill input
3. `select <target> "#country" "US"` — select dropdown
4. `press <target> Enter` — submit
5. `waitfor <target> ".success-message"` — wait for result

### Visual bug investigation
1. `perceive <target>` — understand page structure and layout positions
2. `elshot <target> ".suspect"` — targeted screenshot of the suspicious element
3. `styles <target> ".suspect"` — inspect computed CSS properties
4. Only if needed: `scanshot <target>` — full page visual for broader context

## Source

**Upstream**: [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) (v1.0.1) — locally modified with Windows support, background observation, and additional commands.
