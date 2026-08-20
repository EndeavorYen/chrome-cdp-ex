---
name: chrome-cdp-ex
description: "Your EYES into the user's live Chrome browser and Electron apps. This skill lets you SEE and INTERACT with the user's actual browser or Electron app — their open tabs, logged-in sessions, and live page state. You MUST use this whenever the user's request involves browser content or Electron app inspection in ANY way.\n\nTRIGGER THIS SKILL when the user:\n- References pages they have open: 'I have X open', 'my tabs', 'open tabs'\n- Asks to look at, compare, or analyze anything in their browser: 'compare these pages', 'which looks better', 'check this page'\n- Mentions UI/visual analysis of live pages: 'dashboard', 'UI', 'layout', 'design quality'\n- Asks for screenshots or page inspection: screenshot, inspect, debug, check the page\n- Refers to 'the page', 'the browser', 'my tab' in any context\n- Mentions console errors, page state, or anything requiring browser access\n- Mentions Electron apps or CDP connections: 'Electron', 'electron app', 'CDP', 'CDP_PORT', 'DevTools Protocol', 'desktop app', 'remote-debugging-port'\n\nCRITICAL: NEVER say you cannot see the user's browser or ask users to paste screenshots. You CAN see their browser through this skill. Use `list` to discover open tabs, then `perceive` or `shot`/`scanshot` to see page content.\n\nDo NOT use Playwright — it launches an isolated browser without the user's login state, cookies, or open tabs."
---

# Chrome CDP

Your eyes and hands on the user's live Chrome browser or Electron app through the Chrome DevTools Protocol (CDP). It connects to the browser they already have open, preserving tabs, cookies, login state, and current page state. Use Playwright only when the user explicitly wants a fresh isolated test browser.

## TL;DR: 5-step golden path

Prefer the skill-local launcher over a relative `./bin/chrome-cdp` from an unrelated cwd (Hermes often starts in `/workspace`). Use `$SKILL_DIR/bin/chrome-cdp` for an installed skill, repo-root `./bin/chrome-cdp` from a checkout, `process.execPath`, or `$HERMES_HOME/node/bin/node`. If `node -v` is <22, use the Node 22 path printed by doctor.

1. **Doctor:** `bin/chrome-cdp doctor` checks Node, install path, daemon state, file limits, CDP reachability, and browser-debugging permission.
2. **List/open:** `bin/chrome-cdp list`. Doctor probes `127.0.0.1:9222` and attaches to the daily browser when it is already listening. Isolated `spawn-debug-browser` is fallback only and is not the daily profile. If no usable tab exists after attach, use `open <url>`. Default `open` returns the target prefix plus `Next: cdp text <prefix> --auto`; it does not dump the page unless you pass `--perceive`. `nav <target> <url>` waits until the destination URL is committed and `readyState` is complete, then returns URL+title (and readyState); it does not sit on `loadEventFired` plus a leftover network-quiet floor. `--compact` is one line; `--perceive` dumps AX. `list` is the source of truth for which tab — when doctor reports multiple tabs, pick with `list` / `target --url` instead of following a starred tab, a leftover `perceive <id> -C -d 8` sample, or a daemon next-probe.
3. **Perceive:** `bin/chrome-cdp perceive <target> -C -d 8` to read structure, main/article text, layout hints, console health, and fresh `@ref` handles. For "what does this page say", use `text <target> --auto`.
4. **Act:** `click`, `fill`, `press`, `select`, `scroll`, or `dismiss-modal` using a fresh `@ref` or stable selector. After fill, `press Enter` with a visible listing link (`See N model results`, `a[href*="models?search="]`, `/search?q=`) submits that listing, not the typeahead first repo. Sequential `batch --compact 'fill … | press Enter'` skips mid-pipe fill leftover AX / `/api/quicksearch` settle — typeahead leftover is not the success signal — then `press` probes once (no 1500 ms typeahead poll) or opens `/models?search=<filled>` from the value just set, and returns on the listing URL (`/models?search=`), using `jsclick` or listing navigation so typeahead-overlay mouse compositor wait is not paid. A miss still counts if the listing URL already loaded; it does not send Enter. Standalone fill still settle-diffs. `perceive -C -d 8` ranks that results link first in Visible controls so `click` can hit it. For a named control, `jsclick <target> "Browse 1M+ applications"` or `click` with that name (one-step jsclick, skinny URL receipt; off-screen unique names `scrollIntoView` then click) instead of `perceive -C -d 8` then `scroll down` then retry. Mouse `click @ref` still fail-closes with `no-input-events`. For the window document or nested overflow edge, use `scroll to bottom` / `scroll to top` (skinny `scrollY` or `scrollTop` / `scrollMax` / at-bottom or at-top receipt; `--compact` is metrics only) instead of `perceive` then guessing `scroll down 10000`. When the document cannot scroll, the same commands scroll the nearest overflow container (optional `--scroll-container`) instead of reporting document `0 / 0`. Relative `scroll down N` still settle-diffs. No-op `press Escape`/`Tab`/`Space` and `dismiss-modal` with no dialog are expected no-change / continue — do not send the key name to `overlay`.
5. **Verify/report:** read the action evidence, then use `verify-click`, `perceive <target> --since-action`, or `report <target>` / `report <target> --format json` for handoff.

## When invoked directly (`/chrome-cdp-ex`)

Take action immediately; do not just read this file.

1. Run `bin/chrome-cdp list` to discover open tabs.
2. Show the user the available tabs.
3. If the user's request names a page, app, tab, URL, or visual state, match it to a target and run `bin/chrome-cdp perceive <target> -C -d 8`.
4. If no specific target is clear, ask which tab to inspect after listing the candidates.

## Perceive first

Start with `perceive`, not screenshots. Golden-path `perceive <target> -C -d 8` prefers `main` / `[role=main]` / `article` text over skip-links and nav chrome; visible controls are a short list after the body. Skip-to / 跳至 controls (links or buttons, including `aria-label`) are ranked last so `@1` is content, not a skip-link. If the body is still truncated it prints `Body truncated. Next: cdp text <target> --auto`. Use `text <target> --auto` when the question is "what does this page say". Chrome PDF plugin tabs (`pdf-viewer.v1`) are not HTML documents — `text --auto` reads page-1 text from the PDF bytes; Next for `qa` / `html` / `report` / `report --qa` / `click --qa` / `visual-check` / `responsive-audit` / `snap` / `styles` / `cascade` / `fullshot` / `perceive` (`--cards` / `-s` / `--format json` / `--qa` / `--summary`) / `summary` and other action receipts stays `eval <prefix> "document.contentType"`. Do not retry perceive. A leftover `pdf-viewer.v1` dump is not an AX settle baseline; no-op `press Escape` / Arrow* / `click --js` / `scroll` stay `Outcome: no-change` / continue with Next `eval <prefix> "document.contentType"` when AX cannot observe a plugin change. `hover` snapshots settle-shape AX before mouseMoved, recaptures immediately, and discards an idle recapture without waiting for a later DOM mutation so a later no-op mutator does not steal hover's AX delta. Sequential `batch --compact 'hover … | eval …'` skips that leftover AX recapture so CSS `:hover` (opacity / group-hover) is not raced; confirm `eval` is the success signal. Standalone hover still recaptures. Hover receipts name opacity/visible/groupHover from computed style when available. On virtualized feeds (X Home, infinite timelines), use `perceive <target> --cards` for a capped article/listitem list instead of a full a11y dump; that dump is not an action settle-diff on a page with no feed. A leftover `--cards` / `--role feed` dump with cards is the settle shape for the next `scroll` — unchanged virtualized windows stay `Outcome: no-change` / continue with Next `perceive --cards`, not a full AX recapture. Card identity ignores relative-time chrome in article AX names (`· 2m` / `3h`), including when the clock lives in the article name itself; a third article entering the window is still `Outcome: changed`. A leftover golden-path `perceive -C -d 8` dump is the settle shape for the next `scroll`; viewport `@ref` / Visible-control rect chrome, fold tags (`↑above fold`), and title-only Visible-control selector chrome (`span[title=…]` / `time` GMT) are not a page change. Unchanged identities stay `Outcome: no-change` / continue with Next `perceive -C -d 8` without a Recovery hint that restates that Next command. A Visible-control cap-swap stays `Outcome: changed` but the receipt summarizes the swap; samples prefer accessible names; live collector fallbacks (`img "img"` / `a role=link "link"`) stay in headline membership but do not fill the sample cap. Relative-time / GMT title strings (`2 days ago` / `Thu, 13 Aug 2026 15:18:27 GMT`) stay in headline membership but do not occupy the named 4-sample cap. Names that appear on both sides of a cap-swap (live: a shared commit title) stay in headline membership but do not occupy a named sample slot on both sides; unique file / heading / link names fill the cap. A new file, heading, or link still prints a structural diff. Next stays `perceive -C -d 8` on that leftover scroll, without a Hint `--since-action` double handoff or a generic `Recovery hint: Continue from the observed action evidence.` Honest leftover-ax-scroll receipts drop Interactive census / `Console: clean` / Coords clickxy tutorial chrome and do not reprint Outcome/Receipt/Verdict as the same sentence three times; the leftover `perceive -C -d 8` dump itself still prints those header lines. Honest leftover-ax-scroll `no-change` receipts whose Next is already `perceive -C -d 8` do not reprint `Recovery hint: AX identities unchanged; re-run perceive -C -d 8 instead of report.` They print `Outcome: no-change` without the settle-shape reason `Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.` Honest leftover-ax-scroll `no-change` receipts whose Next is already `perceive -C -d 8` also drop the reprinted `Page:` / `Viewport:` identity header; `Position:` on the action line already states scroll identity, and Next `perceive -C -d 8` re-establishes page identity. They also drop the tautological `(no changes detected in AX tree)` body; `Outcome: no-change` already states that. They also drop the tautological `scroll: dispatched via scroll` / `Target: down` restatement; `Scrolled by … Position: …` already states the action. Leftover-ax-scroll `changed` still prints dispatched/Target, Page / Viewport, and its AX body. Standalone leftover `perceive -C -d 8` dumps still print that no-change line. 0-card leftovers still recapture default AX so a later `click --js` is visible. A leftover `perceive --frame @fN` dump is not a top-level fill/select/click settle-diff; frame-scoped settle is only for `@fN:M` actions. Use `elshot` for one element when visual judgment matters, `shot --annotate` for a viewport ref map, `scanshot` only for full-page pixel review, and `record` when the question is about sequence or cause-and-effect over time.

Refresh `@ref` handles after navigation, DOM rewrites, modal changes, or failed stale-ref actions by running `perceive <target> -C -d 8` again. For scripts or loops, prefer stable CSS selectors over old `@ref` values. If `Focused:` is an input/search, blur it first (`press Escape`) or `perceive -s main` — an open typeahead can replace the page body.

## Prerequisites

- **Existing daily browser:** run `doctor` then `list`. Do not start by clicking `chrome://inspect`. If port 9222 already has the **daily** debug Chrome, that is success (`CDP_PORT=9222` + `list`). A leftover isolated `chrome-cdp-ex-*` profile on 9222 is not daily attach success — next probe is `--daily-profile` (ask first); do not kill the occupant without asking. If 9222 is empty, enable debug on the daily profile first: `bin/chrome-cdp spawn-debug-browser chrome --daily-profile --port 9222` (may restart that Chrome; ask first).
- **No reachable daily browser:** with user consent, launch an isolated debug profile as fallback (not the daily profile), using doctor's `preferredBrowser` (chrome on this Mac), e.g. `bin/chrome-cdp spawn-debug-browser chrome --port 9222 --url https://example.com`.
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

`doctor`, `list`, `open`, `nav`, `target`, `use`, `perceive`, `text --auto`, `eval`, `call`, `click`, `fill`, `press`, `select`, `scroll`, `verify-click`, `dismiss-modal`, `overlay`, `frame`, `cascade`, `inject`, `elshot`, `shot`, `scanshot`, `record`, `waitfor`, `report`, `stop`.

For “what does this page say”, use `text --auto` instead of a deep `perceive`. Use `eval` / `call` for one-line extractions (title, abstract, `fetch` of a raw license file).
