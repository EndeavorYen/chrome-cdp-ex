# Changelog

## v2.1.0

This release consolidates all enhancements since the fork merge into a single version. 42 commands total (14 from upstream, 28 added).

### `@ref` system and action feedback

- **`@ref` indices** — `perceive` assigns every interactive element a ref (`@1`, `@2`, `@3`...) with bounding coordinates `(x,y w×h)`. Refs work as targets in `click`, `fill`, `hover`, and `elshot` — no CSS selectors needed.
- **Action feedback** — `click`, `clickxy`, `press` (Enter/Escape/Tab), and `select` automatically wait for DOM to settle and return a perceive diff showing what changed. No need to manually run `perceive --diff` after actions.
- **`perceive --diff`** — show only changes since last perceive call. Efficient for monitoring page state after interactions.
- **`shot --annotate` / `-a`** — viewport screenshot with red `@ref` bounding box overlays on every interactive element.

### Perceive-first observation

- **`perceive <target> [flags]`** — enriched accessibility tree with inline visual layout annotations. Combines summary metadata (title, URL, viewport, scroll position, interactive element counts, console health) with the compact AX tree, annotated with height, background color, font size, display mode, and viewport visibility (↑above fold / ↓below fold). Gives agents complete page understanding in ~200-400 tokens without screenshots.
  - `--diff`: show only changes since last perceive
  - `-s <sel>` / `--selector`: scope to CSS selector subtree
  - `-i` / `--interactive`: interactive elements only
  - `-d N` / `--depth N`: limit tree depth
  - `-C` / `--cursor-interactive`: include non-ARIA clickable elements (`@c` refs)
- **Style anomaly hints** on table cells — annotates non-default background colors, bold text, and unusual text colors (e.g., `[cell] 70.0%  bg:rgb(255,200,200)  bold`)
- **`elshot <target> <sel|@ref>`** — element-level screenshot: scrolls the element into view, clips capture to its bounding box with 8px padding. No DPR confusion.
- **Perceive-first observation strategy** in SKILL.md — three-tier model (perceive → elshot → scanshot) guiding agents to use structured text first, screenshots as secondary verification.

### New commands (since fork)

- **`text <target>`** — clean text content (strips scripts, styles, SVG)
- **`table <target> [selector]`** — full table data extraction (tab-separated, no row limit)
- **`back <target>`** — navigate back in browser history
- **`forward <target>`** — navigate forward
- **`reload <target>`** — reload current page
- **`closetab <target>`** — close a browser tab
- **`netlog <target> [--clear]`** — network request log (XHR/Fetch/Document with status + timing)
- **`cookieset <target> <cookie>`** — set a cookie (`name=value; domain=.example.com; secure`)
- **`cookiedel <target> <name>`** — delete a cookie by name
- **`dialog <target> [accept|dismiss]`** — dialog history; set auto-accept or auto-dismiss
- **`viewport <target> [WxH]`** — show or set viewport size (e.g., `375x812`)
- **`upload <target> <selector> <paths>`** — upload file(s) to `<input type="file">`
- **`batch <target> <json>`** — execute multiple commands in one call (reduces IPC overhead)
- **`scanshot <target>`** — segmented full-page capture: viewport-sized screenshots with 10% overlap
- **`status <target>`** — URL, title + buffered console errors and exceptions
- **`console <target> [--all|--errors]`** — console buffer (default: unread only)
- **`summary <target>`** — token-efficient page overview (~100 tokens)
- **`fullshot <target> [file]`** — full-page screenshot (single image)
- **`press <target> <key>`** — press keyboard key (Enter, Tab, Escape, Backspace, Space, Arrow*)
- **`scroll <target> <dir|x,y> [px]`** — scroll by direction or coordinates (default 500px)
- **`hover <target> <sel|@ref>`** — hover over element (triggers :hover, tooltips)
- **`waitfor <target> <selector> [ms]`** — wait for element to appear (default 10s)
- **`fill <target> <sel|@ref> <text>`** — clear field + type text (form filling)
- **`select <target> <selector> <value>`** — select dropdown option by value
- **`styles <target> <selector>`** — computed styles (meaningful props only)
- **`cookies <target>`** — list cookies for the current page
- **`snap --full`** — option for complete AX tree (compact is now default)

### Infrastructure

- **Background observation**: `RingBuffer`-based console, exception, and navigation buffering in the daemon
- **Realistic input simulation**: `click` and `loadall` use CDP `Input.dispatchMouseEvent` (mouseMoved → mousePressed → mouseReleased) instead of `el.click()`
- **Smart daemon reuse**: `list` reuses existing daemon sockets, avoiding unnecessary "Allow debugging" prompts
- **Smart target resolution**: commands check running daemon sockets before falling back to pages cache
- **Security validation**: eval expressions are checked for dangerous patterns
- **Plugin manifest**: `plugin.json` for Claude Code integration
- **CLAUDE.md**: project overview, architecture diagram, coding conventions
- **Unit tests**: Vitest test suite with extracted `buildPerceiveTree` for testability
- **WSL2 support**: proven patterns for controlling Windows Chrome from WSL2
- **`edge://` filtering**: `getPages()` filters out Edge internal pages

### Merged from upstream v1.0.2

- **Flatpak browser paths**: Linux Flatpak installations auto-discovered
- **`CDP_HOST` env var**: connect to Chrome on a non-localhost host
- **`LOCALAPPDATA` for RUNTIME_DIR**: Windows daemon sockets go to `%LOCALAPPDATA%\cdp`
- **Daemon error handler**: listen failures reported clearly instead of silent crash
- **`open` cache refresh**: new tabs immediately reflected in pages cache

## v1.0.2 (upstream)

- Windows/WSL: use LOCALAPPDATA, CDP_HOST, add daemon error handler

## v1.0.1 (upstream)

- Linux Flatpak browser path discovery
- MIT LICENSE file added

## v1.0.0 (upstream)

- Initial release: list, snap, eval, shot, html, nav, net, click, clickxy, type, loadall, evalraw, open, stop
