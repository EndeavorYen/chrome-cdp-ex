# chrome-cdp-ex

> **Unreleased candidate:** repository metadata is v2.16.0; install links remain pinned to published v2.15.0.

[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)](skills/chrome-cdp-ex/scripts/cdp.mjs)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)
[![Release v2.15.0](https://img.shields.io/badge/release-v2.15.0-brightgreen)](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.15.0)
[![MIT License](https://img.shields.io/badge/license-MIT-gray)](LICENSE)

**Use the browser you already have open.**

Your agent already has Chrome. What it usually gets is a fat page snapshot — lots of hops, a pile of tokens — or a fresh automated browser that is not the tab with your cookies. chrome-cdp-ex attaches to that live session and does the common jobs in **one step**, with a **short receipt**.

Fat snapshot. Empty PDF. Overlay up, and the snapshot still looks clear. One command. Skinny evidence. The tab you already have.

Playwright is for clean isolated tests. This is for the session that already has your login.

## One step. Skinny receipt.

Measured 2026-08-17. chrome-cdp-ex and Browser Use on main `22c525d4` (page-level Chrome). Playwright: independent headed Chromium, same machine. Viewport 1042×632. n=3 median. Each cell is **steps / chars / wall ms**, then PASS or FAIL. Chars are tokens: UTF-8 length of the operate call's real return / printed status; void click/hover/press is 0.

| job | chrome-cdp-ex | Browser Use | Playwright |
|---|---|---|---|
| scroll to bottom (HF home) | 1 / 62 / 139 PASS | 1 / 118 / 227 PASS | 1 / 41 / 2 PASS |
| nested overflow (Comfy `#content-container`) | 1 / 83 / 144 PASS | 3 / 6307 / 391 PASS | 1 / 70 / 72 PASS |
| click Browse 2M+ models | 1 / 549 / 487 PASS | 2 / 7636 / 507 PASS | 1 / 0 / 352 PASS |
| search submit bert | 1 / 114 / 410 PASS | 5 / 770 / 1261 PASS | 2 / 0 / 1047 PASS |
| nav example.org | 1 / 69 / 297 PASS | 1 / 86 / 16 PASS | 1 / 35 / 12 PASS |
| read HF home | 1 / 3863 / 152 PASS | 1 / 7540 / 6 PASS | 1 / 4427 / 3 PASS |
| hover reveal | 1 / 192 / 145 PASS | 2 / 12025 / 14 PASS | 1 / 0 / 67 PASS |
| PDF text one page | 1 / 4323 / 232 PASS | 1 / 94 / 5 FAIL | 1 / 0 / 2 FAIL |
| overlay detect | 1 / 232 / 142 PASS | 1 / 35139 / 21 FAIL | 1 / 178 / 1 PASS |
| click Browse 1M+ applications | 1 / 580 / 457 PASS | 2 / 7640 / 625 PASS | 1 / 0 / 318 PASS |

Playwright is quicker on the clock for most of these jobs. The win is steps, chars, and the jobs others fail: PDF text comes back empty for both Browser Use and Playwright, and Browser Use's overlay snapshot still looks clear.

## Start

Needs Node.js 22 (built-in WebSocket). This project does **not** publish to the npm registry.

**Pinned release (v2.15.0):**

```bash
curl -L -o pi-chrome-cdp-2.15.0.tgz https://github.com/EndeavorYen/chrome-cdp-ex/releases/download/v2.15.0/pi-chrome-cdp-2.15.0.tgz
mkdir -p chrome-cdp-ex-v2.15.0
tar -xzf pi-chrome-cdp-2.15.0.tgz -C chrome-cdp-ex-v2.15.0 --strip-components=1
cd chrome-cdp-ex-v2.15.0
```

Checksum is on the [GitHub Release](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.15.0).

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

If `node -v` is <22, doctor prints a Node 22 path (`./bin/chrome-cdp` re-execs it when found). Turn on remote debugging at `chrome://inspect/#remote-debugging` (or `edge://inspect`) so it can attach to the browser you already have open.

Command map: [docs/reference.md](docs/reference.md). Skill: [SKILL.md](skills/chrome-cdp-ex/SKILL.md). Host wiring: [INTEGRATIONS.md](INTEGRATIONS.md).

## License

[MIT](LICENSE)

Built on [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) by Petr Baudis. Contributors: [ynezz](https://github.com/ynezz), [Jah-yee](https://github.com/Jah-yee), [Rolf Fredheim](https://github.com/rolfredheim), [hussainweb](https://github.com/hussainweb).
