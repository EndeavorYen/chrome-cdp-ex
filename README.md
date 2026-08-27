# chrome-cdp-ex

[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)](skills/chrome-cdp-ex/scripts/cdp.mjs)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)
[![Release v2.16.0](https://img.shields.io/badge/release-v2.16.0-brightgreen)](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.16.0)
[![MIT License](https://img.shields.io/badge/license-MIT-gray)](LICENSE)

## The tab you already have

**Use the browser you already have open.**

chrome-cdp-ex attaches to that live Chrome or Electron session — cookies, login, open tabs — and does the common jobs in one step with a short receipt.

Playwright is for clean isolated tests. This is for the session that already has your login.

## Quick start

Needs Node.js 22 (built-in WebSocket). This project does **not** publish to the npm registry.

**Pinned release (v2.16.0):**

```bash
curl -L -o pi-chrome-cdp-2.16.0.tgz https://github.com/EndeavorYen/chrome-cdp-ex/releases/download/v2.16.0/pi-chrome-cdp-2.16.0.tgz
mkdir -p chrome-cdp-ex-v2.16.0
tar -xzf pi-chrome-cdp-2.16.0.tgz -C chrome-cdp-ex-v2.16.0 --strip-components=1
cd chrome-cdp-ex-v2.16.0
```

Checksum is on the [GitHub Release](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.16.0).

**Current `main`:**

```bash
git clone https://github.com/EndeavorYen/chrome-cdp-ex.git
cd chrome-cdp-ex
```

Then:

```bash
./bin/chrome-cdp doctor
./bin/chrome-cdp list
```

If `node -v` is <22, doctor prints a Node 22 path (`./bin/chrome-cdp` re-execs it when found). For the daily logged-in session, do **not** expect CDP on Dock/default Chrome or Edge — see [Daily browser CDP](#daily-browser-cdp-chromium-136) below.

Skill: [SKILL.md](skills/chrome-cdp-ex/SKILL.md). Command map: [docs/reference.md](docs/reference.md).

## Daily browser CDP (Chromium 136+)

### Known limitation

From Chrome 136, `--remote-debugging-port` / `--remote-debugging-pipe` are **ignored** on the browser's **default** user-data-dir ([Chrome security change](https://developer.chrome.com/blog/remote-debugging-port)). Edge inherits this. A process can show the flag in `edge://version` and still listen on nothing.

chrome-cdp-ex **cannot** silently attach to an already-running Dock/default Chrome or Edge (no debug port, default profile) without quitting that browser or asking a human to click Allow. Isolated spawn is not that session. Closing a bug because we *detect* the failure is not a fix. See [#368](https://github.com/EndeavorYen/chrome-cdp-ex/issues/368).

### Approaches and tradeoffs

| Approach | Zero click? | Keeps Dock/default cookies? | Survives restart without re-login? | Cron / unattended? | Notes |
|---|---|---|---|---|---|
| 1. Silent CDP on already-open **default** profile | Yes | Yes | n/a | Would be ideal | **Impossible** on Chromium 136+. Not a chrome-cdp-ex bug. |
| 2. **This project now:** persistent non-default dir **as the daily browser**, always launched with `--remote-debugging-port` | Yes after first launch | No — this dir **is** daily for the agent | Yes (same dir) | Yes | One-time sign-in in that profile. Dock default Edge/Chrome is no longer the attach target. Do not delete the dir. |
| 3. Chrome 144+ `chrome://inspect/#remote-debugging` (Allow dialog) | No — click every connect | Yes if the UI exists | n/a | No | Unusable for cron. Edge 151 has no proven equivalent silent API. |
| 4. Fresh isolated `--user-data-dir` under `/tmp` each run | Yes | No | No | Only after re-login every run | Fine for throwaway automation. Not daily. |
| 5. Second always-on debug window, leave Dock Edge untouched | Yes after first launch | No (copy of login in the second profile) | Yes | Yes | Same mechanism as (2), but daily human browsing stays on default. Two browsers. |

### What this project does now

**Option 2 — zero click, replace daily.** The agent daily browser is a **fixed** user-data-dir, always started with remote debugging. First launch: sign in (X, etc.) once. Later launches of the **same** dir do not need a new login. Restarts do not. Re-login only if the dir is deleted, the path changes, or the site expires the session.

Do not target Dock/default Edge. Do not kill it. Do not wait for an inspect Allow click.

macOS Edge example (pick one machine-local path and keep it):

```bash
DIR="$HOME/Library/Application Support/chrome-cdp-ex/daily-edge"
mkdir -p "$DIR"
# First time and every later time — same DIR:
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --user-data-dir="$DIR" \
  --remote-debugging-port=9222 \
  --no-first-run
./bin/chrome-cdp doctor
./bin/chrome-cdp list
```

Or:

```bash
./bin/chrome-cdp spawn-debug-browser edge --port 9222 --user-data-dir "$DIR"
```

Empty 9222: `doctor` first step is that persistent dir (ask first), not `--daily-profile`, not `/tmp` isolated, not inspect Allow.

`--daily-profile` still means the **browser default** dir. That path cannot enable CDP on 136+. Do not use `--daily-profile` as a substitute for the persistent dir above.

## Demo

- [Redesign experiment](https://endeavoryen.github.io/chrome-cdp-ex/experiment/showcase.html) — same ugly page, three tools, five rounds. [challenge](https://endeavoryen.github.io/chrome-cdp-ex/experiment/challenge.html) · [A](https://endeavoryen.github.io/chrome-cdp-ex/experiment/result-A.html) · [B](https://endeavoryen.github.io/chrome-cdp-ex/experiment/result-B.html) · [C](https://endeavoryen.github.io/chrome-cdp-ex/experiment/result-C.html)
- [Codex Killer Path demo](https://endeavoryen.github.io/chrome-cdp-ex/experiment/codex-killer-path-demo.html) — 60-second scene page for the [video](experiment/codex-killer-path-demo.mp4)
- [Smart Eye benchmark](https://endeavoryen.github.io/chrome-cdp-ex/experiment/benchmark.html) — v2.15.0 mixed local campaign proof ([still](https://endeavoryen.github.io/chrome-cdp-ex/experiment/benchmark-proof.png))

Measured jobs / engineer grid: [docs/pk-324-board.md](docs/pk-324-board.md).

Host wiring (optional, not required for the live path): [INTEGRATIONS.md](INTEGRATIONS.md).

## License

[MIT](LICENSE)

Built on [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) by Petr Baudis. Contributors: [ynezz](https://github.com/ynezz), [Jah-yee](https://github.com/Jah-yee), [Rolf Fredheim](https://github.com/rolfredheim), [hussainweb](https://github.com/hussainweb).
