# Integrations (one-pager)

Cross-host install for **chrome-cdp-ex**. One CLI runtime + optional stdio MCP. Official publish surface: GitHub Releases, and npm after one manual first publish.

## Bootstrap

```bash
# From repo or release tarball root
node scripts/setup.mjs --detect
node scripts/setup.mjs --for cursor      # print MCP snippet
node scripts/setup.mjs --for cursor --write
node scripts/setup.mjs --for claude
node scripts/setup.mjs --for codex
node scripts/setup.mjs --for openclaw
node scripts/setup.mjs --for hermes
node scripts/setup.mjs --for pi
node scripts/setup.mjs --verify          # doctor + MCP initialize smoke
```

Short CLI wrapper (no npm install required):

```bash
./bin/chrome-cdp doctor
./bin/chrome-cdp list
```

## Host matrix

| Host | Recommended route | Setup |
|------|-------------------|-------|
| Claude Code | CLI skill / plugin | `claude --plugin-dir .` or [guide](docs/integrations/claude.md) |
| Codex | CLI skill | [guide](docs/integrations/codex.md) |
| Cursor | MCP | `setup.mjs --for cursor --write` → `.cursor/mcp.json` |
| OpenClaw | MCP (+ skill) | [guide](docs/integrations/openclaw.md) |
| Hermes | CLI | [guide](docs/integrations/hermes.md) |
| Pi | CLI / `pi.skills` | [guide](docs/integrations/pi.md) |

Details: [docs/integrations/](docs/integrations/) · Host overlays: [skills/chrome-cdp-ex/hosts/](skills/chrome-cdp-ex/hosts/) · Schemas: [docs/schemas/](docs/schemas/)

## Grok Bot

Replace Grok Bot computer use / browser use with chrome-cdp-ex. From-zero setup: [docs/integrations/grok-bot.md](docs/integrations/grok-bot.md). Cursor IDE vs Grok Bot are two surfaces; do not mix them.

## Golden path

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node skills/chrome-cdp-ex/scripts/cdp.mjs list
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

Enable browser remote debugging at `chrome://inspect/#remote-debugging` (or `edge://inspect`), or with consent: `spawn-debug-browser`.
