# Codex

## Install

```bash
mkdir -p ~/.codex/skills
cp -R skills/chrome-cdp-ex ~/.codex/skills/
node scripts/setup.mjs --for codex
```

The slim `SKILL.md` loads first; deep command docs live in `references/commands.md`.

## Route

Prefer **CLI** (`node .../scripts/cdp.mjs ...`). Use MCP only when the Codex session is MCP-first.

## Verify

```bash
node ~/.codex/skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node scripts/setup.mjs --verify
```

See also: `skills/chrome-cdp-ex/hosts/codex.md`.
