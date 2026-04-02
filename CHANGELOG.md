# Changelog

## [2.3.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/pi-chrome-cdp-v2.2.0...pi-chrome-cdp-v2.3.0) (2026-04-02)


### Features

* add 'open' command to create new tabs ([17f71cd](https://github.com/EndeavorYen/chrome-cdp-ex/commit/17f71cd7018ea3cd5c12bc6008f74424b73d4750))
* add [@ref](https://github.com/ref) system, action feedback, scope flags, and 7 new commands ([de73c42](https://github.com/EndeavorYen/chrome-cdp-ex/commit/de73c420cdf49c5227d6d95d93a7b03dbe4df1e0))
* add [@ref](https://github.com/ref) system, perceive diff, batch commands, security validation, and annotated screenshots ([a687ca5](https://github.com/EndeavorYen/chrome-cdp-ex/commit/a687ca5eb969279e03e4d4fa5e4361eb46f835c4))
* add CI/CD pipeline with GitHub Actions and release-please ([bb19bee](https://github.com/EndeavorYen/chrome-cdp-ex/commit/bb19beeea6578f1c0fba3ce3b77a1c5d96785faf))
* add Linux Flatpak browser paths to DevToolsActivePort discovery ([1fd55c7](https://github.com/EndeavorYen/chrome-cdp-ex/commit/1fd55c777125eff23e6ad3a972e694999a3a5bfb))
* add Linux Flatpak browser paths to DevToolsActivePort discovery ([59199f1](https://github.com/EndeavorYen/chrome-cdp-ex/commit/59199f146428e12ed786b7ac73ad25db6aa5686d))
* add perceive/elshot commands, rewrite skill for perceive-first observation ([e35ec41](https://github.com/EndeavorYen/chrome-cdp-ex/commit/e35ec41e99a104febc106ff80a31b8171efcfa30))
* add plugin.json for Claude Code marketplace integration ([c14bc60](https://github.com/EndeavorYen/chrome-cdp-ex/commit/c14bc601696ece549aee97557e9c348eb20d8fa3))
* add redesign experiment, showcase page, and GitHub Pages deployment ([297f477](https://github.com/EndeavorYen/chrome-cdp-ex/commit/297f477843dde34abe1f5d22b14de8adaf2bd733))
* add scanshot command for segmented full-page capture ([ca4f45e](https://github.com/EndeavorYen/chrome-cdp-ex/commit/ca4f45eb2fd8fd63a54ca5b00ba849c2a9abfe53))
* add Windows support via named pipes ([3e3e1f0](https://github.com/EndeavorYen/chrome-cdp-ex/commit/3e3e1f0bcd894ea31f84c95604bed9959fa7fba7))
* auto-perceive for nav/scroll/viewport, batch pipe syntax + parallel mode ([414ad67](https://github.com/EndeavorYen/chrome-cdp-ex/commit/414ad6768dd7ad9fba3eeb9bd66245f7d029b959))
* Electron CDP support via CDP_PORT env var ([dfd7771](https://github.com/EndeavorYen/chrome-cdp-ex/commit/dfd77719a7b1be990c2db0158947f6a8843fa6e4))
* expand browser discovery to Chrome, Chromium, Brave, Edge, Vivaldi on macOS/Linux ([356d928](https://github.com/EndeavorYen/chrome-cdp-ex/commit/356d928c27f50a9f0c3aae3e2b8c94c5d90b0c87))
* inline hints for text/perceive/waitfor, AI chatbot workflow pattern ([7db4157](https://github.com/EndeavorYen/chrome-cdp-ex/commit/7db4157e967ea19a2af18efd6751a602f3cf91e1))
* merge local fork with upstream — add 13 commands, background observation, and WSL2 support ([dd522cc](https://github.com/EndeavorYen/chrome-cdp-ex/commit/dd522ccbca751b61136d7c6400470817d7b8232e))
* multi-tier screenshot fallback for Electron, snapshot→perceive guidance ([a9eace7](https://github.com/EndeavorYen/chrome-cdp-ex/commit/a9eace76fabd12c97fecf9038902ae20c55706b0))
* open auto-attaches + auto-perceives, single-tab comparison workflow ([461d79d](https://github.com/EndeavorYen/chrome-cdp-ex/commit/461d79da2c5946c88fe5a4d9251417abd8d0dac3))
* **perceive:** collect table cell style hints in browser-side eval ([a44ae5e](https://github.com/EndeavorYen/chrome-cdp-ex/commit/a44ae5e5cb9f0a8452b4b5f6d54f9776c896e18a))
* **perceive:** render style hints on table cell AX nodes ([5720485](https://github.com/EndeavorYen/chrome-cdp-ex/commit/5720485a23e86cfadf53b8e2d646a4cc0350d3e8))
* redesign showcase page — auto-scaling iframes, chrome-cdp highlight, view buttons ([8c6eb9a](https://github.com/EndeavorYen/chrome-cdp-ex/commit/8c6eb9af5bd1f7a54571a48370956398c265c909))
* text selector, waitfor --text, perceive -x exclude, compact diff ([d3383bd](https://github.com/EndeavorYen/chrome-cdp-ex/commit/d3383bd1da261f20d07bd8f5be04fff2f4fb05f4))
* v2.2.0 — inject + cascade commands, CSS origin tracing ([af63acd](https://github.com/EndeavorYen/chrome-cdp-ex/commit/af63acd23c7636423cf73731e92e095dde127759))
* waitfor --gone for streaming end detection, chatbot workflow ([8a72cad](https://github.com/EndeavorYen/chrome-cdp-ex/commit/8a72cad2b5639859796e89f502a89d4781549bcb))


### Bug Fixes

* perceive truncated-row leak, icon noise, and shot+scroll guidance ([c2699fa](https://github.com/EndeavorYen/chrome-cdp-ex/commit/c2699fac9c35659c9e42f847c660302a35543371))
* **perceive:** address style hint matching issues from code review ([1549dc1](https://github.com/EndeavorYen/chrome-cdp-ex/commit/1549dc1eb560cd5ceb8d235c8b57a0d7e3c2d2cf))
* reduce perceive noise and discourage scanshot for comparisons ([fb403d3](https://github.com/EndeavorYen/chrome-cdp-ex/commit/fb403d34fcbf62d6132e11db837d4c1c72777efa))
* strengthen skill trigger to prevent agents from using Playwright instead ([fdba9cc](https://github.com/EndeavorYen/chrome-cdp-ex/commit/fdba9ccac9f5e092984483a3c444ef4c725a668b))
* update pages cache after 'open' command ([05d8562](https://github.com/EndeavorYen/chrome-cdp-ex/commit/05d8562b45ef1b5d45f3a6e9038d9bee4dda69ad))


### Miscellaneous

* add Electron trigger words, unify skill description to English-only ([d653faf](https://github.com/EndeavorYen/chrome-cdp-ex/commit/d653fafd1e5a3ad31b8249cea70267381c7c9725))
* remove experiment round screenshots ([b410118](https://github.com/EndeavorYen/chrome-cdp-ex/commit/b4101186c8d33e91a8abbf7f0cac4fbdc8ba5e84))
* rename skill from chrome-cdp to chrome-cdp-ex ([3f61dfa](https://github.com/EndeavorYen/chrome-cdp-ex/commit/3f61dfa1030897ecf6f18d141019c894d64b7df9))


### Refactoring

* extract perceivePageScript, fix duplicate export, add design doc ([0b3ceff](https://github.com/EndeavorYen/chrome-cdp-ex/commit/0b3ceff0976cbe51c0117a545c0cb8ce3f76a166))
* extract shared helpers, fix scanshot clipping bug ([b5eb336](https://github.com/EndeavorYen/chrome-cdp-ex/commit/b5eb3360af1002ac00a9a051811cd32e36e7be03))
* improve skill trigger coverage and reduce SKILL.md redundancy ([01b0512](https://github.com/EndeavorYen/chrome-cdp-ex/commit/01b05125e10f9c16df564c162d94d8dea6040b21))
* **perceive:** simplify style hints — single pass, capped scan ([80efded](https://github.com/EndeavorYen/chrome-cdp-ex/commit/80efdeddada7da145653672957b864ea2d593715))
* remove listDaemonSockets, use pages cache everywhere ([da4a87e](https://github.com/EndeavorYen/chrome-cdp-ex/commit/da4a87e06577ce37885591b8f317316dafc157e8))


### Documentation

* add design spec for reducing agent screenshot overuse ([b49d816](https://github.com/EndeavorYen/chrome-cdp-ex/commit/b49d816659d0b12053bc43542297e44aa47548cf))
* add implementation plan for reducing screenshot overuse ([c70d33a](https://github.com/EndeavorYen/chrome-cdp-ex/commit/c70d33a03c171434d2bb007a4c5a241bee8de56e))
* add WSL2→Windows architecture diagram to README ([457cf82](https://github.com/EndeavorYen/chrome-cdp-ex/commit/457cf82c4c91a7b06eccbee4f83d69f2d9f34219))
* address spec review — text-content keying, scope non-table to future ([b49d401](https://github.com/EndeavorYen/chrome-cdp-ex/commit/b49d40147578ec972c68ea5b50c82411b3646031))
* compact README — bullet features, mermaid sequence diagram, merged install block ([d34f7e3](https://github.com/EndeavorYen/chrome-cdp-ex/commit/d34f7e372e49dea8812ef1b28a80df68e534fa18))
* promotional README rewrite with PK-tested comparison data ([d8427ea](https://github.com/EndeavorYen/chrome-cdp-ex/commit/d8427eaefbd6dffd02002dd004d27b77ed4cfe7f))
* rename to chrome-cdp-ex, restructure README with feature highlights ([9bbebb2](https://github.com/EndeavorYen/chrome-cdp-ex/commit/9bbebb267b42437cbe6b737d02941993756aa3d2))
* revamp README with comparison table, [@ref](https://github.com/ref) demo, and simpler install steps ([2537b79](https://github.com/EndeavorYen/chrome-cdp-ex/commit/2537b79c7fa46619c0491ed7f2bc670f0c6340f6))
* rewrite README for impact, consolidate CHANGELOG to v2.1.0 ([68262f6](https://github.com/EndeavorYen/chrome-cdp-ex/commit/68262f604505b0740e841d27ca98cad58387e3e1))
* **SKILL.md:** scenario-driven verification guidance, document style hints ([87aadb5](https://github.com/EndeavorYen/chrome-cdp-ex/commit/87aadb510bb364053858f454bb8964126fc172d5))
* update README and CHANGELOG for perceive/elshot commands ([a252907](https://github.com/EndeavorYen/chrome-cdp-ex/commit/a25290773b00aafb499683199c40fdb3583e844b))


### Tests

* add unit tests with Vitest, extract buildPerceiveTree for testability ([6c19149](https://github.com/EndeavorYen/chrome-cdp-ex/commit/6c191490b9964fc6c294bd483844a50998ef707b))

## v2.2.0

Two new commands: **Operational** (`inject`) and **Cognitive** (`cascade`). 44 commands total.

### New commands

- **`inject <target> --css|--css-file|--js-file|--remove`** — Live CSS/JS injection with tracking and removal. Each injection gets a `data-cdp-inject` ID for targeted cleanup. Validates URLs via `validateUrl` to prevent SSRF. Eliminates the repetitive `eval` boilerplate for frontend development.
- **`cascade <target> <selector|@ref> [property]`** — CSS origin tracing via `CSS.getMatchedStylesForNode`. Shows the full cascade: which rule won, which were overridden, source file + line number, and inherited properties. Includes inline `style=""` attributes (highest specificity). Answers "which file do I edit to change this style?" in one command.

### Improvements

- **Extracted `perceivePageScript()`** — the 190-line browser-side JS for `perceive` is now a named, testable function instead of an inline template literal.
- **Optimized cursor-interactive scan** — `perceive -C` uses targeted CSS selectors instead of `querySelectorAll('*')`, reducing `getComputedStyle` calls on large pages.
- **`_screenshotTier` reset** — screenshot fallback tier now resets per daemon session, preventing cross-target state leaks.
- **Organized `__test__` exports** — grouped by category with comments; removed duplicate `isRef` export.
- **`CSS.enable`** added to daemon initialization for `cascade` support.
- **SKILL.md** — four-tier perception model (added Temporal tier for future `record` command), decision tables for when to use `record` vs `perceive --diff`.

### Tests

- 163 → 195 tests (+32)
- New: `perceivePageScript` (5), `buildPerceiveTree` integration (6), `injectStr` (9+3 security), `cascadeStr` (8+1 inline style)

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
