---
name: chrome-cdp
description: "Interact with local Chrome browser via CDP — take screenshots, inspect DOM, debug pages, automate forms.\n當用戶說「看瀏覽器」「瀏覽器內容」「查看網頁」「截圖」「screenshot」「Chrome」「inspect page」「debug page」「頁面上有什麼」「瀏覽器畫面」「看我的頁面」「check the page」「browser」時使用。"
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

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

**Screenshots**: `shot`, `scanshot`, and `fullshot` print saved file paths. After taking a screenshot, use the **Read tool** to view the image file. For long pages, prefer `scanshot` (multiple readable segments) over `fullshot` (single tiny image).

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list` (e.g. `A7BA5C64`). The CLI rejects ambiguous prefixes.

### List open pages

```bash
scripts/cdp.mjs list
```

### Take a screenshot

```bash
scripts/cdp.mjs shot     <target> [file]  # viewport screenshot
scripts/cdp.mjs scanshot <target>         # segmented full-page (multiple viewport-sized images)
scripts/cdp.mjs fullshot <target> [file]  # single full-page image (may be tiny on long pages)
```

- **`shot`** — viewport only. Use when you only need the currently visible area.
- **`scanshot`** — **default choice for capturing a full page.** Scrolls through and captures multiple viewport-sized images with 10% overlap. Each segment is full-resolution and readable. Read each segment image with the Read tool for analysis.
- **`fullshot`** — single image of entire page. **Do NOT use for analysis** — on long pages text becomes unreadably small. Only useful for generating a single file for non-AI consumption.

> **IMPORTANT:** When asked to screenshot, capture, or look at a full page, **always use `scanshot`**, never `fullshot`. The segmented approach produces readable images that can be properly analyzed.

### Accessibility tree snapshot

```bash
scripts/cdp.mjs snap <target>          # compact (default) — filters noise
scripts/cdp.mjs snap <target> --full   # complete AX tree with all nodes
```

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

> **Agent tip:** Start with `status` when debugging — it shows URL, title, and buffered console errors. Use `summary` for a token-efficient overview (~100 tokens).

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

## Tips

- Prefer `snap` over `html` for page structure — compact by default, use `snap --full` for complete tree.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Daemons keep CDP sessions alive per tab (auto-exit after 20min idle), so only the first command per tab triggers Chrome's "Allow debugging" dialog.
- **Shell quoting**: CSS selectors like `input[type=text]` contain shell metacharacters. Always wrap in quotes: `click <t> 'input[type="text"]'`.
- **WSL2 gotcha**: Never improvise WSL2→Windows connectivity (localhost, gateway IP, port forwarding, launching Chrome from WSL). The only proven pattern: user starts Chrome on Windows, agent uses Windows-side Node.js to run the CDP script.

## Workflow Patterns

### Debugging a broken page
1. `status <target>` — check for console errors (buffered since daemon start)
2. `console <target> --errors` — detailed error messages + stack traces
3. `snap <target>` — inspect page structure
4. `styles <target> ".broken-element"` — check computed styles

### Form automation
1. `fill <target> "#email" "user@example.com"` — fill input
2. `select <target> "#country" "US"` — select dropdown
3. `press <target> Enter` — submit
4. `waitfor <target> ".success-message"` — wait for result

### Visual bug investigation
1. `summary <target>` — quick page overview
2. `scanshot <target>` — capture full page as readable segments
3. Read each segment image to locate the issue
4. `styles <target> ".suspect"` — inspect layout properties

## Source

**Upstream**: [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) (v1.0.1) — locally modified with Windows support, background observation, and additional commands.
