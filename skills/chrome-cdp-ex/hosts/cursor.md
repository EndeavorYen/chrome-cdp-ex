# Cursor host overlay

Prefer MCP in Cursor so agents can call browser tools directly while the CLI remains available for shell workflows.

## MCP server snippet

Use an absolute path to this repository or installed package:

```json
{
  "mcpServers": {
    "chrome-cdp-ex": {
      "command": "node",
      "args": [
        "/absolute/path/to/skills/chrome-cdp-ex/scripts/mcp-server.mjs"
      ]
    }
  }
}
```

The MCP adapter routes to the same `scripts/cdp.mjs` runtime and exposes doctor, list/open, target selection, perception, actions, verification, modal dismissal, QA, screenshots, and reports. Use the CLI directly when a shell command is simpler:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs list
```
