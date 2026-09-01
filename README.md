# chrome-cdp-ex

[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)](skills/chrome-cdp-ex/scripts/cdp.mjs)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)
[![Release v2.17.0](https://img.shields.io/badge/release-v2.17.0-brightgreen)](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.17.0)
[![MIT License](https://img.shields.io/badge/license-MIT-gray)](LICENSE)

<p align="center">
  <a href="experiment/codex-killer-path-demo.mp4"><img src="experiment/codex-killer-path-demo-poster.png" alt="Codex uses chrome-cdp-ex to perceive, act, and read a short receipt on a live tab" width="720"></a>
</p>

<p align="center">
  <strong><a href="experiment/codex-killer-path-demo.mp4">Watch the 60-second Codex demo.</a></strong>
  Agent perceives, acts, and gets a short receipt on the tab you already have.
</p>

## The tab you already have

**Use the browser you already have open.**

Your agent already has Chrome. What it usually gets is a fat page snapshot, or a fresh automated browser that is not the tab with your cookies. chrome-cdp-ex attaches to that live session and does the common jobs in one step, with a short receipt.

Playwright is for clean isolated tests. This is for the session that already has your login.

For Electron, launch with a remote debugging port. Set `CDP_PORT` to that port. Use `9333` as the example, not daily Chrome `9222`.

```bash
CDP_PORT=9333 ./bin/chrome-cdp list
```

## Quick start

Needs Node.js 22 (built-in WebSocket). This project does **not** publish to the npm registry.

From a checkout or unpacked release:

```bash
./bin/chrome-cdp doctor
./bin/chrome-cdp list
```

`list` prints target prefixes. Perceive the tab, act once, read the one-line receipt, then `stop` when done.

```bash
./bin/chrome-cdp perceive <target> -C -d 8
./bin/chrome-cdp click <target> @ref
./bin/chrome-cdp fill <target> @ref "you@example.com"
./bin/chrome-cdp press <target> Enter
./bin/chrome-cdp stop
```

`click`, `fill`, and `press` each print a one-line receipt with URL, outcome, and next command.

If `node -v` is <22, doctor prints a Node 22 path (`./bin/chrome-cdp` re-execs it when found).

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

Skill for coding agents: [SKILL.md](skills/chrome-cdp-ex/SKILL.md). Command map: [docs/reference.md](docs/reference.md).

Measured jobs and the engineer grid live in [docs/pk-324-board.md](docs/pk-324-board.md).

Host wiring is not required for the live path. See [INTEGRATIONS.md](INTEGRATIONS.md).

## Daily browser CDP

From Chrome 136, `--remote-debugging-port` is ignored on the default profile. chrome-cdp-ex cannot silently attach to an already-running default Chrome or Edge. Use a persistent non-default user-data-dir that you always launch with remote debugging, then sign in once. See [Daily browser CDP](docs/daily-browser-cdp.md).

## License

[MIT](LICENSE)

Built on [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) by Petr Baudis. Contributors: [ynezz](https://github.com/ynezz), [Jah-yee](https://github.com/Jah-yee), [Rolf Fredheim](https://github.com/rolfredheim), [hussainweb](https://github.com/hussainweb).
