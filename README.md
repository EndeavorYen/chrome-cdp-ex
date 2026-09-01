# chrome-cdp-ex

[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)](skills/chrome-cdp-ex/scripts/cdp.mjs)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)
[![Release v2.17.0](https://img.shields.io/badge/release-v2.17.0-brightgreen)](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.17.0)
[![MIT License](https://img.shields.io/badge/license-MIT-gray)](LICENSE)

## The tab you already have

**Use the browser you already have open.**

chrome-cdp-ex attaches to that live Chrome or Electron session. Cookies, login, and open tabs stay. Common jobs return a short receipt.

Playwright is for clean isolated tests. This is for the session that already has your login.

## Quick start

Needs Node.js 22 (built-in WebSocket). This project does **not** publish to the npm registry.

**Pinned release (v2.17.0):**

```bash
curl -L -o pi-chrome-cdp-2.17.0.tgz https://github.com/EndeavorYen/chrome-cdp-ex/releases/download/v2.17.0/pi-chrome-cdp-2.17.0.tgz
mkdir -p chrome-cdp-ex-v2.17.0
tar -xzf pi-chrome-cdp-2.17.0.tgz -C chrome-cdp-ex-v2.17.0 --strip-components=1
cd chrome-cdp-ex-v2.17.0
```

Checksum is on the [GitHub Release](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.17.0).

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

If `node -v` is <22, doctor prints a Node 22 path (`./bin/chrome-cdp` re-execs it when found).

From Chrome 136, the default profile cannot enable CDP. Use a persistent non-default dir always launched with remote debugging. Ask first. See [Daily browser CDP](docs/daily-browser-cdp.md).

Skill: [SKILL.md](skills/chrome-cdp-ex/SKILL.md). Command map: [docs/reference.md](docs/reference.md).

Measured jobs / engineer grid: [docs/pk-324-board.md](docs/pk-324-board.md).

Host wiring (optional, not required for the live path): [INTEGRATIONS.md](INTEGRATIONS.md).

## License

[MIT](LICENSE)

Built on [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) by Petr Baudis. Contributors: [ynezz](https://github.com/ynezz), [Jah-yee](https://github.com/Jah-yee), [Rolf Fredheim](https://github.com/rolfredheim), [hussainweb](https://github.com/hussainweb).
