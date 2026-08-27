---
name: chrome-cdp-ex
description: "Your EYES into the user's live Chrome browser and Electron apps. This skill lets you SEE and INTERACT with the user's actual browser or Electron app — their open tabs, logged-in sessions, and live page state. You MUST use this whenever the user's request involves browser content or Electron app inspection in ANY way.\n\nTRIGGER THIS SKILL when the user:\n- References pages they have open: 'I have X open', 'my tabs', 'open tabs'\n- Asks to look at, compare, or analyze anything in their browser: 'compare these pages', 'which looks better', 'check this page'\n- Mentions UI/visual analysis of live pages: 'dashboard', 'UI', 'layout', 'design quality'\n- Asks for screenshots or page inspection: screenshot, inspect, debug, check the page\n- Refers to 'the page', 'the browser', 'my tab' in any context\n- Mentions console errors, page state, or anything requiring browser access\n- Mentions Electron apps or CDP connections: 'Electron', 'electron app', 'CDP', 'CDP_PORT', 'DevTools Protocol', 'desktop app', 'remote-debugging-port'\n\nCRITICAL: NEVER say you cannot see the user's browser or ask users to paste screenshots. You CAN see their browser through this skill. Use `list` to discover open tabs, then `perceive` or `shot` to see page content.\n\nDo NOT use Playwright — it launches an isolated browser without the user's login state, cookies, or open tabs."
---

# Chrome CDP

Your eyes and hands on the user's live Chrome browser or Electron app through the Chrome DevTools Protocol (CDP). It connects to the browser they already have open, preserving tabs, cookies, login state, and current page state. Use Playwright only when the user explicitly wants a fresh isolated test browser.

Prefer `$SKILL_DIR/bin/chrome-cdp` for an installed skill, repo-root `./bin/chrome-cdp` from a checkout, `process.execPath`, or `$HERMES_HOME/node/bin/node`. If `node -v` is <22, use the Node 22 path printed by doctor.

## 5-step golden path

1. **Doctor or list:** `bin/chrome-cdp doctor` then `bin/chrome-cdp list`. Doctor checks Node, install path, daemon state, CDP reachability, and debugging permission.
2. **List / open / nav:** `list` picks the tab you already have. `open <url>` if none. `nav <target> <url>` to change URL. Isolated `spawn-debug-browser` is fallback only — ask first.
3. **Perceive:** `bin/chrome-cdp perceive <target> -C -d 8` for structure and `@ref`s. For "what does this page say", `text --auto`.
4. **Act:** `click`, `fill`, `press`, `select`, `scroll`, or `dismiss-modal` with a fresh `@ref` or stable selector. `click --js` is a JS-click flag, not a separate command. `eval --b64` is a base64 flag, not a separate command. `inject` / `cascade` / `waitfor` / `elshot` / `shot` as needed.
5. **Evidence:** read the one-line action receipt (URL, outcome, next). Then `stop` when done.

## Chrome 136 / daily profile

From Chrome 136, the **default** profile cannot enable CDP (`--remote-debugging-port` is ignored). Use a persistent non-default daily dir always launched with remote debugging, or an isolated spawn. Ask first. Do not quit Dock/default Chrome or Edge to "fix" this.

## Electron

Launch with a remote debugging port and set `CDP_PORT` to that port — example `9333`, not daily Chrome `9222`.

```bash
CDP_PORT=9333 ./bin/chrome-cdp list
```

If a tab daemon is already live, unprefixed `doctor` must use that session.

## When invoked directly (`/chrome-cdp-ex`)

Take action immediately; do not just read this file.

1. Run `bin/chrome-cdp list` to discover open tabs.
2. Show the user the available tabs.
3. If the request names a page, match it and `perceive <target> -C -d 8`.
4. If no target is clear, ask which tab after listing.

## Need more depth?

- `references/commands.md` — exhaustive command and edge-case reference.
- `references/recipes.md` — situational playbooks.
- `references/troubleshooting.md` — doctor failures, WSL2, unreachable CDP.

## Survivors

`doctor`, `list`, `open`, `nav`, `perceive`, `text`, `click`, `fill`, `press`, `select`, `scroll`, `eval`, `inject`, `cascade`, `waitfor`, `dismiss-modal`, `elshot`, `shot`, `spawn-debug-browser`, `stop`.
