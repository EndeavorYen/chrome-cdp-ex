# Cursor

## Install (recommended: MCP)

From the repo or tarball root:

```bash
node scripts/setup.mjs --for cursor --write
```

This merges a stdio MCP server into `./.cursor/mcp.json`:

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

Print without writing:

```bash
node scripts/setup.mjs --for cursor
```

Optional: set `CDP_PORT` in the environment or in the MCP `env` block for Electron / explicit ports.

## Route

Prefer **MCP** in Cursor. Mutating tools require `confirm: true`.

## Verify

```bash
node scripts/setup.mjs --verify
```

See also: `skills/chrome-cdp-ex/hosts/cursor.md`.
