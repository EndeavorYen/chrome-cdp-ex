# OpenClaw

## Install

1. Copy the portable skill:

```bash
cp -R skills/chrome-cdp-ex <openclaw-skills-dir>/chrome-cdp-ex
```

2. Register the stdio MCP server with absolute paths (print snippet):

```bash
node scripts/setup.mjs --for openclaw
```

Example MCP registration shape:

```json
{
  "mcpServers": {
    "chrome-cdp-ex": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/skills/chrome-cdp-ex/scripts/mcp-server.mjs"]
    }
  }
}
```

## Route

Prefer **MCP** when OpenClaw is MCP-capable; fall back to shell CLI for advanced allowlisted commands via `run_command`.

See also: `skills/chrome-cdp-ex/hosts/openclaw.md`.
