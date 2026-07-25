# Claude Code

## Install

From a checkout or release tarball root:

```bash
claude --plugin-dir .
```

Global skill install:

```bash
mkdir -p ~/.claude/skills
cp -R skills/chrome-cdp-ex ~/.claude/skills/
```

Bootstrap helper:

```bash
node scripts/setup.mjs --for claude
node scripts/setup.mjs --verify
```

## Route

Prefer **CLI** via the skill (`cdp.mjs`). MCP is optional if the session already speaks MCP.

## First commands

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node skills/chrome-cdp-ex/scripts/cdp.mjs list
```

See also: `skills/chrome-cdp-ex/hosts/claude.md`.
