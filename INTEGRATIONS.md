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

Evidence status is intentionally narrower than installation support. `documented` means the route is maintained in this release; `setup-smoke` means configuration/bootstrap was exercised; `live-validated` requires the full perceive → act → receipt → since-action → report loop. The [versioned manifest](docs/benchmarks/host-validation.v1.json) is authoritative.

| Host | Recommended route | Evidence status | Last validation | Setup / evidence |
|------|-------------------|-----------------|-----------------|------------------|
| Claude Code | CLI skill / plugin | documented | 2026-08-12 | `claude --plugin-dir .` or [guide](docs/integrations/claude.md) |
| Codex | CLI skill | live-validated | 2026-08-12 | [Codex Killer Path](docs/examples/codex-killer-path.md) |
| Cursor | MCP | documented | 2026-08-12 | `setup.mjs --for cursor --write` → `.cursor/mcp.json` |
| OpenClaw | MCP (+ skill) | documented | 2026-08-12 | [guide](docs/integrations/openclaw.md) |
| Hermes | CLI | documented | 2026-08-12 | [guide](docs/integrations/hermes.md) |
| Pi | CLI / `pi.skills` | documented | 2026-08-12 | [guide](docs/integrations/pi.md) |

Details: [docs/integrations/](docs/integrations/) · Host overlays: [skills/chrome-cdp-ex/hosts/](skills/chrome-cdp-ex/hosts/) · Schemas: [docs/schemas/](docs/schemas/) · [Validation manifest](docs/benchmarks/host-validation.v1.json)

## Golden path

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node skills/chrome-cdp-ex/scripts/cdp.mjs list
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

Enable browser remote debugging at `chrome://inspect/#remote-debugging` (or `edge://inspect`), or with consent: `spawn-debug-browser`.
