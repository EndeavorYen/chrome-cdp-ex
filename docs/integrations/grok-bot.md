# Grok Bot from-zero setup: chrome-cdp-ex

Replace Grok Bot computer use / browser use for reading and driving pages.

Parent: https://github.com/EndeavorYen/chrome-cdp-ex/issues/322 (epic). Contrast board: https://github.com/EndeavorYen/chrome-cdp-ex/issues/324

#322 stays open: this guide is from-zero setup, not Grok Bot default replacement.
#324 stays open: this guide does not remeasure the 10-job contrast board.

This is a setup guide, not a PK rerun. A Grok Bot live attach was already done on 2026-09-02 (Taipei). Do not re-open that test.

Repo: https://github.com/EndeavorYen/chrome-cdp-ex

## Hard limit (Chrome 136+)

Chrome 136 and later ignore remote-debugging port / pipe switches when they target the default Chrome data directory.

Source: https://developer.chrome.com/blog/remote-debugging-port (Chrome for Developers, 2025-03-17).

What that means for Grok Bot:

- Cannot hang chrome-cdp-ex on the everyday default Chrome/Edge profile. Those switches are ignored. No error. The port never comes up.
- Must start Chrome/Edge with a non-default user-data-dir AND enable remote debugging on that instance. Exact switch names are in the Chrome blog. Repo README shows `spawn-debug-browser` (also a separate directory). Launch recipe: [Daily browser CDP](../daily-browser-cdp.md).
- Cookies stay inside that debug profile. They do not copy from the default everyday profile. Log in once on the debug Chrome if the job needs a logged-in site.

Same rule for Edge.

The in-browser inspect page is a toggle for an instance that already has a reachable debugging endpoint. It does not override the Chrome 136 default-profile block.

## 0. Check these first

- Node.js 22+. PATH `node` v20 fails doctor.
- Install Node 22 or newer. PATH Node 20 is not enough.
- Use a dedicated Chrome user-data directory, not the default profile.
- Set `CDP_PORT` to the debugging port of that Chrome.
- After this works, stop using Grok Bot computer use and browser use for pages.

## 1. Get the tree

GitHub project: https://github.com/EndeavorYen/chrome-cdp-ex
Releases: https://github.com/EndeavorYen/chrome-cdp-ex/releases
README has the pinned tag. If `bin/chrome-cdp` is not executable, call node on `skills/chrome-cdp-ex/scripts/cdp.mjs`.

```bash
git clone https://github.com/EndeavorYen/chrome-cdp-ex.git
cd chrome-cdp-ex
```

## 2. Node 22

Run `node -v`. Need 22 or newer.

```bash
node -v
```

On the 2026-09-02 Grok Bot machine PATH was v20.19.2 (blocked). `/exec-daemon/node` was v22.14.0 (worked). Use that Node 22 binary whenever PATH Node is older than 22.

## 3. Start debug Chrome

Dedicated user-data directory. Not the default profile. Enable remote debugging on that instance. Then:

```bash
export CDP_PORT=<port>
```

`spawn-debug-browser` (with consent) also uses a separate directory. Same Chrome 136 rule. It will not attach to everyday default Chrome.

```bash
./bin/chrome-cdp spawn-debug-browser
```

If `bin/chrome-cdp` is mode 644:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser
```

Electron: start with a remote-debugging port and set `CDP_PORT`. See [INTEGRATIONS.md](../../INTEGRATIONS.md).

## 4. Prove it (CLI)

`doctor`, then `list`, then `perceive`, then `open` a URL, then `shot`.
`doctor` must show CDP reachable.

```bash
export CDP_PORT=<port>
./bin/chrome-cdp doctor
./bin/chrome-cdp list
./bin/chrome-cdp perceive <target> -C -d 8
./bin/chrome-cdp open <url>
./bin/chrome-cdp shot <target>
```

If `bin/chrome-cdp` is not executable:

```bash
export CDP_PORT=<port>
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node skills/chrome-cdp-ex/scripts/cdp.mjs list
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
node skills/chrome-cdp-ex/scripts/cdp.mjs open <url>
node skills/chrome-cdp-ex/scripts/cdp.mjs shot <target>
```

## 5. Make it Grok Bot browser (MCP)

Cursor IDE vs Grok Bot are two surfaces. Do not mix them.

Grok Bot: add a local stdio MCP (user must confirm AddMcpServer). `command` = absolute Node 22; `args` = absolute `mcp-server.mjs`; `env` `CDP_PORT`.

```json
{
  "mcpServers": {
    "chrome-cdp-ex": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/skills/chrome-cdp-ex/scripts/mcp-server.mjs"],
      "env": {
        "CDP_PORT": "<port>"
      }
    }
  }
}
```

After connect: `doctor` / `list` / `perceive` / `open` through chrome-cdp-ex. Do not fall back to computer use or browser use for pages.

## 6. Agent golden path

`doctor` → `list` (or `open` URL) → `perceive` → act → `perceive --since-action` → `report`

```bash
./bin/chrome-cdp doctor
./bin/chrome-cdp list
./bin/chrome-cdp open <url>
./bin/chrome-cdp perceive <target> -C -d 8
./bin/chrome-cdp click <target> @ref
./bin/chrome-cdp perceive <target> --since-action
./bin/chrome-cdp report <target>
```

## 7. Snags

- Default profile is a dead end on Chrome 136+.
- `doctor` without `CDP_PORT` misses custom-dir Chrome.
- PATH Node 20 fails closed.
- `bin/chrome-cdp` may be mode 644.
