---
name: chrome-cdp-ex
description: "Your EYES into the user's live Chrome browser and Electron apps. This skill lets you SEE and INTERACT with the user's actual browser or Electron app — their open tabs, logged-in sessions, and live page state. You MUST use this whenever the user's request involves browser content or Electron app inspection in ANY way.\n\nTRIGGER THIS SKILL when the user:\n- References pages they have open: 'I have X open', 'my tabs', 'open tabs'\n- Asks to look at, compare, or analyze anything in their browser: 'compare these pages', 'which looks better', 'check this page'\n- Mentions UI/visual analysis of live pages: 'dashboard', 'UI', 'layout', 'design quality'\n- Asks for screenshots or page inspection: screenshot, inspect, debug, check the page\n- Refers to 'the page', 'the browser', 'my tab' in any context\n- Mentions console errors, page state, or anything requiring browser access\n- Mentions Electron apps or CDP connections: 'Electron', 'electron app', 'CDP', 'CDP_PORT', 'DevTools Protocol', 'desktop app', 'remote-debugging-port'\n\nCRITICAL: NEVER say you cannot see the user's browser or ask users to paste screenshots. You CAN see their browser through this skill. Use `list` to discover open tabs, then `perceive` or `shot`/`scanshot` to see page content.\n\nDo NOT use Playwright — it launches an isolated browser without the user's login state, cookies, or open tabs."
---

# Chrome CDP

Your eyes and hands on the user's live Chrome browser or Electron app through the Chrome DevTools Protocol (CDP). It connects to the browser they already have open, preserving tabs, cookies, login state, and current page state. Use Playwright only when the user explicitly wants a fresh isolated test browser.

## TL;DR: 5-step golden path

1. **Doctor:** `node skills/chrome-cdp-ex/scripts/cdp.mjs doctor` checks Node, install path, daemon state, file limits, CDP reachability, and browser-debugging permission.
2. **List/open:** `node skills/chrome-cdp-ex/scripts/cdp.mjs list`; if no usable tab exists, use `open <url>` or, with user consent, `spawn-debug-browser edge --port 9222 --url <url>`.
3. **Perceive:** `node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8` to read structure, text, layout hints, console health, and fresh `@ref` handles.
4. **Act:** `click`, `fill`, `press`, `select`, `scroll`, or `dismiss-modal` using a fresh `@ref` or stable selector.
5. **Verify/report:** read the action evidence, then use `verify-click`, `perceive <target> --since-action`, or `report <target>` / `report <target> --format json` for handoff.

## When invoked directly (`/chrome-cdp-ex`)

Take action immediately; do not just read this file.

1. Run `node skills/chrome-cdp-ex/scripts/cdp.mjs list` to discover open tabs.
2. Show the user the available tabs.
3. If the user's request names a page, app, tab, URL, or visual state, match it to a target and run `node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8`.
4. If no specific target is clear, ask which tab to inspect after listing the candidates.

## Perceive first

Start with `perceive`, not screenshots. It returns the accessibility tree, visible text, layout/style hints, interactive `@ref` handles, and console health in a compact form. Use `elshot` for one element when visual judgment matters, `shot --annotate` for a viewport ref map, `scanshot` only for full-page pixel review, and `record` when the question is about sequence or cause-and-effect over time.

Refresh `@ref` handles after navigation, DOM rewrites, modal changes, or failed stale-ref actions by running `perceive <target> -C -d 8` again. For scripts or loops, prefer stable CSS selectors over old `@ref` values.

## Prerequisites

- **Existing browser:** open `chrome://inspect/#remote-debugging` (or `edge://inspect`) and enable remote debugging when the browser asks.
- **No reachable browser:** with user consent, launch an isolated debug profile, e.g. `node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser edge --port 9222 --url https://example.com`.
- **Electron:** launch the app with a remote debugging port and set `CDP_PORT=<port>` before running commands.
- **Runtime:** Node.js 22+ is required because the runtime uses built-in WebSocket and has zero runtime npm dependencies.

## Invoking commands

Find `scripts/cdp.mjs` relative to the installed skill directory, then run it with Node:

```bash
# From this repository or a checked-out package
node skills/chrome-cdp-ex/scripts/cdp.mjs list
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8

# From an installed skill directory
node /absolute/path/to/chrome-cdp-ex/scripts/cdp.mjs doctor

# Electron explicit port
CDP_PORT=9222 node /absolute/path/to/chrome-cdp-ex/scripts/cdp.mjs list
```

Useful target helpers: `target --url <substring>`, `target --title <text>`, `use <target> --name app`, `forget app`, and `open <url> --reuse-url`. `list` aliases are `tabs` and `ls`; `press` has alias `key`; `viewport` has alias `resize`.

## Need more depth?

- `references/commands.md` — exhaustive command and edge-case reference copied from the former full skill body.
- `references/recipes.md` — situational playbooks for UI review, inert clicks, CSS cascade, modals, OAuth, forms, and live CSS prototyping.
- `references/troubleshooting.md` — actionable recovery for doctor failures, WSL2, unreachable CDP, debug browser launch, Electron screenshot fallbacks, and stale refs.

## High-signal commands to remember

`doctor`, `list`, `open`, `target`, `use`, `perceive`, `click`, `fill`, `press`, `select`, `scroll`, `verify-click`, `dismiss-modal`, `overlay`, `frame`, `cascade`, `inject`, `elshot`, `shot`, `scanshot`, `record`, `waitfor`, `report`, `stop`.
