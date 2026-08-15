---
name: chrome-cdp-ex
description: "Your EYES into the user's live Chrome browser and Electron apps. This skill lets you SEE and INTERACT with the user's actual browser or Electron app — their open tabs, logged-in sessions, and live page state. You MUST use this whenever the user's request involves browser content or Electron app inspection in ANY way.\n\nTRIGGER THIS SKILL when the user:\n- References pages they have open: 'I have X open', 'my tabs', 'open tabs'\n- Asks to look at, compare, or analyze anything in their browser: 'compare these pages', 'which looks better', 'check this page'\n- Mentions UI/visual analysis of live pages: 'dashboard', 'UI', 'layout', 'design quality'\n- Asks for screenshots or page inspection: screenshot, inspect, debug, check the page\n- Refers to 'the page', 'the browser', 'my tab' in any context\n- Mentions console errors, page state, or anything requiring browser access\n- Mentions Electron apps or CDP connections: 'Electron', 'electron app', 'CDP', 'CDP_PORT', 'DevTools Protocol', 'desktop app', 'remote-debugging-port'\n\nCRITICAL: NEVER say you cannot see the user's browser or ask users to paste screenshots. You CAN see their browser through this skill. Use `list` to discover open tabs, then `perceive` or `shot`/`scanshot` to see page content.\n\nDo NOT use Playwright — it launches an isolated browser without the user's login state, cookies, or open tabs."
---

# Chrome CDP

Your eyes and hands on the user's live Chrome browser or Electron app through the Chrome DevTools Protocol (CDP). It connects to the browser they already have open, preserving tabs, cookies, login state, and current page state. Use Playwright only when the user explicitly wants a fresh isolated test browser.

## TL;DR: 5-step golden path

Prefer the skill-local launcher over a relative `./bin/chrome-cdp` from an unrelated cwd (Hermes often starts in `/workspace`). Use `$SKILL_DIR/bin/chrome-cdp` for an installed skill, repo-root `./bin/chrome-cdp` from a checkout, `process.execPath`, or `$HERMES_HOME/node/bin/node`. If `node -v` is <22, use the Node 22 path printed by doctor.

1. **Doctor:** `bin/chrome-cdp doctor` checks Node, install path, daemon state, file limits, CDP reachability, and browser-debugging permission.
2. **List/open:** `bin/chrome-cdp list`; if no usable tab exists, use `open <url>` or, with user consent, `spawn-debug-browser edge --port 9222 --url <url>`. Default `open` returns the target prefix plus `Next: cdp text <prefix> --auto`; it does not dump the page unless you pass `--perceive`. `list` is the source of truth for which tab — when doctor reports multiple tabs, pick with `list` / `target --url` instead of following a starred tab, a leftover `perceive <id> -C -d 8` sample, or a daemon next-probe.
3. **Perceive:** `bin/chrome-cdp perceive <target> -C -d 8` to read structure, main/article text, layout hints, console health, and fresh `@ref` handles. For "what does this page say", use `text <target> --auto`.
4. **Act:** `click`, `fill`, `press`, `select`, `scroll`, or `dismiss-modal` using a fresh `@ref` or stable selector. No-op `press Escape`/`Tab`/`Space` and `dismiss-modal` with no dialog are expected no-change / continue — do not send the key name to `overlay`.
5. **Verify/report:** read the action evidence, then use `verify-click`, `perceive <target> --since-action`, or `report <target>` / `report <target> --format json` for handoff.

## When invoked directly (`/chrome-cdp-ex`)

Take action immediately; do not just read this file.

1. Run `bin/chrome-cdp list` to discover open tabs.
2. Show the user the available tabs.
3. If the user's request names a page, app, tab, URL, or visual state, match it to a target and run `bin/chrome-cdp perceive <target> -C -d 8`.
4. If no specific target is clear, ask which tab to inspect after listing the candidates.

## Perceive first

Start with `perceive`, not screenshots. Golden-path `perceive <target> -C -d 8` prefers `main` / `[role=main]` / `article` text over skip-links and nav chrome; visible controls are a short list after the body. Skip-to / 跳至 controls (links or buttons, including `aria-label`) are ranked last so `@1` is content, not a skip-link. If the body is still truncated it prints `Body truncated. Next: cdp text <target> --auto`. Use `text <target> --auto` when the question is "what does this page say". Chrome PDF plugin tabs (`pdf-viewer.v1`) are not HTML documents — Next is `eval <prefix> "document.contentType"`, including from `qa` / `html` / `report` / `report --qa` / `click --qa` / `visual-check` / `responsive-audit` / `snap` / `styles` / `cascade` / `fullshot` / `perceive` (`--cards` / `-s` / `--format json` / `--qa` / `--summary`) / `summary` and other action receipts; do not retry perceive/text. A leftover `pdf-viewer.v1` dump is not an AX settle baseline; no-op `press Escape` / Arrow* / `click --js` / `scroll` stay `Outcome: no-change` / continue with Next `eval <prefix> "document.contentType"` when AX cannot observe a plugin change. `hover` refreshes the last-perceive settle baseline so a later no-op mutator does not steal hover's AX delta. On virtualized feeds (X Home, infinite timelines), use `perceive <target> --cards` for a capped article/listitem list instead of a full a11y dump; that dump is not an action settle-diff on a page with no feed. A leftover `perceive --frame @fN` dump is not a top-level fill/select/click settle-diff; frame-scoped settle is only for `@fN:M` actions. Use `elshot` for one element when visual judgment matters, `shot --annotate` for a viewport ref map, `scanshot` only for full-page pixel review, and `record` when the question is about sequence or cause-and-effect over time.

Refresh `@ref` handles after navigation, DOM rewrites, modal changes, or failed stale-ref actions by running `perceive <target> -C -d 8` again. For scripts or loops, prefer stable CSS selectors over old `@ref` values. If `Focused:` is an input/search, blur it first (`press Escape`) or `perceive -s main` — an open typeahead can replace the page body.

## Prerequisites

- **Existing browser:** open `chrome://inspect/#remote-debugging` (or `edge://inspect`) and enable remote debugging when the browser asks.
- **No reachable browser:** with user consent, launch an isolated debug profile, e.g. `bin/chrome-cdp spawn-debug-browser edge --port 9222 --url https://example.com`.
- **Electron:** launch the app with a remote debugging port and set `CDP_PORT=<port>` before running commands.
- **Runtime:** Node.js 22 is required because the runtime uses built-in WebSocket and has zero runtime npm dependencies. If `node -v` is <22, use the Node 22 path printed by doctor.

## Invoking commands

Find `scripts/cdp.mjs` relative to the installed skill directory. Prefer `$SKILL_DIR/bin/chrome-cdp` (installed copy), repo-root `./bin/chrome-cdp` (checkout), `process.execPath`, or `$HERMES_HOME/node/bin/node` over unqualified PATH `node`. Do not assume cwd is the skill directory.

```bash
# From this repository or a checked-out package (wrapper re-execs Node 22 if needed)
./bin/chrome-cdp list
./bin/chrome-cdp perceive <target> -C -d 8

# Explicit Node 22 binary (Hermes / fnm / nvm)
"$HERMES_HOME/node/bin/node" skills/chrome-cdp-ex/scripts/cdp.mjs list

# From an installed skill directory (Hermes cwd is often not the skill dir)
"$HERMES_HOME/node/bin/node" /absolute/path/to/chrome-cdp-ex/bin/chrome-cdp doctor
"$HERMES_HOME/node/bin/node" /absolute/path/to/chrome-cdp-ex/scripts/cdp.mjs doctor

# Electron explicit port
CDP_PORT=9222 ./bin/chrome-cdp list
```

Useful target helpers: `target --url <substring>`, `target --title <text>`, `use <target> --name app`, `forget app`, and `open <url> --reuse-url`. `list` aliases are `tabs` and `ls`; `press` has alias `key`; `viewport` has alias `resize`.

## Need more depth?

- `references/commands.md` — exhaustive command and edge-case reference copied from the former full skill body.
- `references/recipes.md` — situational playbooks for reading a page, UI review, inert clicks, CSS cascade, modals, OAuth, forms, and live CSS prototyping.
- `references/troubleshooting.md` — actionable recovery for doctor failures, WSL2, unreachable CDP, debug browser launch, Electron screenshot fallbacks, and stale refs.

## High-signal commands to remember

`doctor`, `list`, `open`, `target`, `use`, `perceive`, `text --auto`, `eval`, `call`, `click`, `fill`, `press`, `select`, `scroll`, `verify-click`, `dismiss-modal`, `overlay`, `frame`, `cascade`, `inject`, `elshot`, `shot`, `scanshot`, `record`, `waitfor`, `report`, `stop`.

For “what does this page say”, use `text --auto` instead of a deep `perceive`. Use `eval` / `call` for one-line extractions (title, abstract, `fetch` of a raw license file).
