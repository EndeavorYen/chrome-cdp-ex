# Pi host overlay

This repository is packaged as a Pi skills package via `package.json` metadata. Install from a GitHub Release tarball or a git checkout.

```json
{
  "name": "chrome-cdp-ex",
  "version": "2.22.0",
  "keywords": ["pi-package", "pi", "pi-coding-agent", "skills", "chrome", "cdp", "browser", "devtools"],
  "pi": {
    "skills": ["./skills"]
  }
}
```

The skill entry point is `skills/chrome-cdp-ex/SKILL.md`; command runtime is `skills/chrome-cdp-ex/scripts/cdp.mjs`; optional MCP runtime is `skills/chrome-cdp-ex/scripts/mcp-server.mjs`.
