# Codex host overlay

Use the main `../SKILL.md` as the skill instructions. For a standalone Codex skill install, the usual path is `~/.codex/skills/chrome-cdp-ex`.

```bash
node ~/.codex/skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node ~/.codex/skills/chrome-cdp-ex/scripts/cdp.mjs list
node ~/.codex/skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

Set `CDP_PORT=<port>` for Electron or explicit DevTools ports.
