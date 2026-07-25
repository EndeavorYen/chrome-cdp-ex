# Integrations (one-pager)

Cross-host install for **chrome-cdp-ex**. One CLI runtime + optional stdio MCP. Official publish surface: GitHub Releases (not npm registry).

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
|------|-------------------|--------|
| Claude Code | CLI skill / plugin | `claude --plugin-dir .` or copy to `~/.claude/skills/` |
| Codex | CLI skill | copy to `~/.codex/skills/` |
| Cursor | MCP | `setup.mjs --for cursor --write` → `.cursor/mcp.json` |
| OpenClaw | MCP (+ skill) | see `docs/integrations/openclaw.md` |
| Hermes | CLI | see `docs/integrations/hermes.md` |
| Pi | CLI / `pi.skills` | package metadata already points at `./skills` |

Details: [docs/integrations/](docs/integrations/) · Host overlays: [skills/chrome-cdp-ex/hosts/](skills/chrome-cdp-ex/hosts/) · Schemas: [docs/schemas/](docs/schemas/)

## Golden path

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node skills/chrome-cdp-ex/scripts/cdp.mjs list
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

Enable browser remote debugging at `chrome://inspect/#remote-debugging` (or `edge://inspect`), or with consent: `spawn-debug-browser`.
