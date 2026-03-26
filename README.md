# chrome-cdp-ex

[![42 Commands](https://img.shields.io/badge/commands-42-orange)](skills/chrome-cdp/scripts/cdp.mjs)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)](skills/chrome-cdp/scripts/cdp.mjs)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)
[![MIT License](https://img.shields.io/badge/license-MIT-gray)](LICENSE)

**Every browser automation tool launches a clean, isolated browser.**
**This one connects to yours — your tabs, your logins, your cookies, your page state.**

## The redesign experiment

Same ugly page. Same prompt. 5 rounds. Three independent AI agents — each with a different browser observation tool. **The only variable: how much the tool reveals about the page's visual state.**

| Before | After: `chrome-cdp` | After: Playwright | After: Other CDP |
|--------|---------------------|-------------------|------------------|
| ![before](experiment/round-0.png) | ![chrome-cdp result](experiment/final-A.png) | ![playwright result](experiment/final-B.png) | ![other cdp result](experiment/final-C.png) |

The agent with `perceive` (layout + colors + spacing + coordinates) produced the most polished result — because it could **see** what needed fixing, not just read the source code. [**View the live comparison →**](https://endeavoryen.github.io/chrome-cdp-ex/experiment/showcase.html)

### The numbers

| | `chrome-cdp-ex` | Playwright | Other CDP tools |
|---|---|---|---|
| **Calls to fully understand a page** | **1** (`perceive`) | 3+ (snapshot + console + viewport) | 2+ (snap + console) |
| **Tokens per page snapshot** | **~800** (with layout + styles) | ~3,500 (no layout, no styles) | ~400 (no layout, no styles) |
| **Calls to act and verify** | **1** (auto feedback) | 2+ (act + re-snapshot) | 2+ (act + re-snapshot) |
| **`@ref` with coordinates** | **Yes** — `@3 (200,350 200×30)` | No — `ref=e376` (ID only) | No |
| **Your real browser session** | **Yes** — tabs, cookies, logins | No — isolated Chromium | Varies |
| **Background event collection** | **Yes** — console, errors, navigations | Only while connected | No |
| **WSL2 → Windows** | **Yes** — built-in | No | No |
| **Dependencies** | **0** | Playwright + Chromium binary | Varies |
| **Commands** | **42** | N/A (programmatic API) | ~14 |

## One command. Complete page understanding.

Other tools give the agent a screenshot and say "figure it out." Or dump a raw accessibility tree with no context. `perceive` gives the agent **everything it needs in one call:**

```text
$ cdp perceive abc1
📍 My App (1280×720 scroll:0/2400) — https://app.example.com
  [banner] ↕80px bg:rgb(26,26,46) ↑above fold
    [nav] flex
      @1 [link] "Home" (12,8 60×20)
      @2 [link] "Settings" (80,8 70×20)
  [main] ↕2920px
    @3 [textbox] "Email" (200,350 200×30)
    @4 [button] "Submit" (200,400 100×40)
  [contentinfo] ↕160px ↓below fold
Console: 2 errors | Interactive: 12 a, 3 button, 2 input
```

Structure. Layout. Styles. Scroll position. Console health. Interactive element count. Every `@ref` with bounding coordinates. **~800 tokens.** A Playwright snapshot of the same page? **~3,500 tokens** — and still no layout, no styles, no console, no coordinates.

## Why agents choose this

```mermaid
sequenceDiagram
    participant Agent
    participant Chrome

    Agent->>Chrome: perceive
    Chrome-->>Agent: AX tree + layout + styles + @refs with coordinates<br/>+ console health + interactive counts

    Agent->>Chrome: click @4
    Chrome-->>Agent: △ [dialog] "Submitted successfully"<br/>△ @4 [button] → disabled
```

**One call to understand. One call to act. Zero calls to check what happened** — action feedback is automatic.

Compare that to other tools: `snapshot` → parse → `click` → `snapshot` again → diff manually → `console_messages` → ... That's 5+ round trips for what this tool does in 2.

## Quick Start

```bash
git clone https://github.com/EndeavorYen/chrome-cdp-ex.git

# Option A: load in Claude Code (current session)
claude --plugin-dir ./chrome-cdp-ex

# Option B: install globally (available in all projects)
cp -r chrome-cdp-ex/skills/chrome-cdp ~/.claude/skills/
```

Then enable Chrome debugging: navigate to `chrome://inspect/#remote-debugging` and toggle the switch. Do **not** restart Chrome with `--remote-debugging-port`.

**Requires:** Node.js 22+ (uses built-in WebSocket). Auto-detects Chrome, Chromium, Brave, Edge, and Vivaldi on macOS, Linux (including Flatpak), and Windows.

<details>
<summary><strong>Advanced Configuration</strong></summary>

- `CDP_PORT_FILE` — override the DevToolsActivePort path
- `CDP_HOST` — override the Chrome host (default: `127.0.0.1`)

</details>

## How It Works

```mermaid
graph TB
    subgraph Agent["AI Agent (Claude Code / Cursor / Amp)"]
        CLI["cdp.mjs CLI"]
    end

    subgraph Daemons["Background Daemons (one per tab)"]
        D1["Daemon A<br/><small>RingBuffer: console, exceptions, navigations</small>"]
        D2["Daemon B"]
    end

    subgraph Chrome["Chrome (user's browser)"]
        T1["Tab A"]
        T2["Tab B"]
        T3["Tab C <small>(no daemon)</small>"]
    end

    CLI -- "list (direct CDP)" --> Chrome
    CLI -- "Unix socket /<br/>named pipe" --> D1
    CLI -- "Unix socket /<br/>named pipe" --> D2
    D1 -- "WebSocket<br/>CDP session" --> T1
    D2 -- "WebSocket<br/>CDP session" --> T2
```

Each tab gets its own daemon process that holds the CDP session open — Chrome's "Allow debugging" dialog fires **once per tab**, not once per command. Daemons auto-exit after 20 minutes of inactivity and passively collect console/exception/navigation events into ring buffers.

## Commands (42 total)

<details>
<summary><strong>Discovery & Lifecycle</strong></summary>

```bash
list                               # list open tabs (shows targetId prefixes)
open   [url]                       # open new tab (default: about:blank)
stop   [target]                    # stop daemon(s)
closetab <target>                  # close a browser tab
```

</details>

<details open>
<summary><strong>Perception</strong> — start here</summary>

```bash
perceive <target> [flags]          # enriched AX tree with @ref indices + coordinates
                                   #   --diff: show only changes since last perceive
                                   #   -s <sel>: scope to CSS selector subtree
                                   #   -i: interactive elements only
                                   #   -d N: limit tree depth
                                   #   -C: include non-ARIA clickable elements
snap     <target> [--full]         # accessibility tree (compact by default)
summary  <target>                  # token-efficient overview (~100 tokens)
status   <target>                  # URL, title + new console/exception entries
console  <target> [--all|--errors] # console buffer (default: unread only)
text     <target>                  # clean text content (strips scripts/styles/SVG)
table    <target> [selector]       # full table data extraction (tab-separated)
```

</details>

<details>
<summary><strong>Visual Capture</strong></summary>

```bash
shot     <target> [file|--annotate] # viewport screenshot; --annotate overlays @ref labels
elshot   <target> <sel|@ref>        # element screenshot (auto scroll + clip, no DPR issues)
scanshot <target>                   # segmented full-page (readable viewport-sized images)
fullshot <target> [file]            # single full-page image (may be tiny on long pages)
```

</details>

<details>
<summary><strong>Inspection</strong></summary>

```bash
html    <target> [selector]        # full HTML or scoped to CSS selector
eval    <target> <expr>            # evaluate JS in page context
styles  <target> <selector>        # computed styles (meaningful props only)
net     <target>                   # network performance entries
netlog  <target> [--clear]         # network request log (XHR/Fetch with status + timing)
cookies <target>                   # list cookies for current page
cookieset <target> <cookie>        # set a cookie ("name=value; domain=...")
cookiedel <target> <name>          # delete a cookie by name
```

</details>

<details>
<summary><strong>Interaction</strong></summary>

```bash
click   <target> <sel|@ref>        # click element (CDP mouse events, not el.click())
clickxy <target> <x> <y>           # click at CSS pixel coordinates
type    <target> <text>            # type at focused element (cross-origin safe)
press   <target> <key>             # press key (Enter, Tab, Escape, etc.)
scroll  <target> <dir|x,y> [px]   # scroll (down/up/left/right; default 500px)
hover   <target> <sel|@ref>        # hover (triggers :hover, tooltips)
fill    <target> <sel|@ref> <text> # clear field + type (form filling)
select  <target> <selector> <val>  # select dropdown option by value
waitfor <target> <selector> [ms]   # wait for element to appear (default 10s)
loadall <target> <selector> [ms]   # click "load more" until gone
upload  <target> <selector> <paths> # upload file(s) to <input type="file">
dialog  <target> [accept|dismiss]  # dialog history; set auto-accept or auto-dismiss
```

</details>

<details>
<summary><strong>Navigation & Viewport</strong></summary>

```bash
nav     <target> <url>             # navigate to URL and wait for load
back    <target>                   # navigate back in browser history
forward <target>                   # navigate forward
reload  <target>                   # reload current page
viewport <target> [WxH]           # show or set viewport size (e.g. 375x812)
```

</details>

<details>
<summary><strong>Advanced</strong></summary>

```bash
batch   <target> <json>            # execute multiple commands in one call
                                   # [{"cmd":"click","args":["@1"]},{"cmd":"perceive","args":["--diff"]}]
evalraw <target> <method> [json]   # raw CDP command passthrough
                                   # e.g. evalraw <t> "DOM.getDocument" '{}'
```

</details>

**Action feedback:** `click`, `clickxy`, `press` (Enter/Escape/Tab), and `select` automatically wait for DOM to settle and return a perceive diff showing what changed — no need to manually run `perceive --diff` after these actions.

`<target>` is a unique targetId prefix from `list`. See [SKILL.md](skills/chrome-cdp/SKILL.md) for detailed usage, workflow patterns, and coordinate system.

<details>
<summary><strong>WSL2 → Windows Browser Control</strong></summary>

This tool works across the WSL2 → Windows boundary — most CDP tools don't.

```mermaid
graph LR
    subgraph WSL2["WSL2 (Linux)"]
        Agent["AI Agent<br/>(Claude Code)"]
        Script["cdp.mjs"]
    end

    subgraph Windows["Windows"]
        Node["node.exe"]
        Chrome["Chrome<br/>(user's browser)"]
    end

    Agent -- "invokes" --> Script
    Script -- "/mnt/c/.../node.exe" --> Node
    Node -- "CDP WebSocket<br/>localhost:port" --> Chrome
```

The key insight: WSL2 cannot connect to Windows `localhost` directly, so the script calls **Windows-side `node.exe`** via its `/mnt/c/` path, which then connects to Chrome natively.

The proven pattern:

1. Start Chrome **on Windows** and enable debugging at `chrome://inspect/#remote-debugging`
2. Agent uses **Windows-side Node.js** to run the CDP script (WSL cannot connect to Windows localhost directly)
3. Locate Node.js:
   ```bash
   powershell.exe -NoProfile -Command "(Get-Command node -ErrorAction SilentlyContinue).Source"
   ```
4. Convert to WSL mount path and invoke:
   ```bash
   "/mnt/c/.../node.exe" scripts/cdp.mjs list
   ```

See [SKILL.md](skills/chrome-cdp/SKILL.md) for full WSL2 setup instructions.

</details>

## Credits

- **Original**: [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) by Petr Baudis — daemon-per-tab architecture and core CDP client
- **Contributors**: [ynezz](https://github.com/ynezz) (Flatpak paths), [Jah-yee](https://github.com/Jah-yee), [Rolf Fredheim](https://github.com/rolfredheim)
- **This fork**: `@ref` system, perceive-first workflow, action feedback, background observation, realistic input simulation, form automation, WSL2 support, and 28 additional commands

## License

[MIT](LICENSE)
