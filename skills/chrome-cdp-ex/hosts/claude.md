# Claude host overlay

Use the main `../SKILL.md` as the always-loaded skill. This overlay only records Claude-specific install paths.

## Paths

- Claude plugin install: locate the plugin directory, then run `node <plugin-dir>/skills/chrome-cdp-ex/scripts/cdp.mjs <command>`.
- Standalone skill install: `~/.claude/skills/chrome-cdp-ex`, then run `node ~/.claude/skills/chrome-cdp-ex/scripts/cdp.mjs <command>`.

## Quick check

```bash
node ~/.claude/skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node ~/.claude/skills/chrome-cdp-ex/scripts/cdp.mjs list
```

If installed as a plugin, substitute the plugin directory path for `~/.claude/skills/chrome-cdp-ex`.
