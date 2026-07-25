# OpenClaw host overlay

Use both the skill instructions and the MCP server when OpenClaw supports MCP tools.

## Skill path

Install or reference `skills/chrome-cdp-ex/SKILL.md` as the always-loaded browser-inspection skill, with deep references under `skills/chrome-cdp-ex/references/`.

## MCP

```json
{
  "mcpServers": {
    "chrome-cdp-ex": {
      "command": "node",
      "args": ["/absolute/path/to/skills/chrome-cdp-ex/scripts/mcp-server.mjs"]
    }
  }
}
```

Fallback shell form:

```bash
node /absolute/path/to/skills/chrome-cdp-ex/scripts/cdp.mjs doctor
```
