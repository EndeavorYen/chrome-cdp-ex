# Hermes host overlay

Use the main `../SKILL.md` instructions and invoke the CLI directly from shell.

```bash
node /absolute/path/to/skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node /absolute/path/to/skills/chrome-cdp-ex/scripts/cdp.mjs list
node /absolute/path/to/skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

For Electron or a fixed DevTools endpoint, prefix commands with `CDP_PORT=<port>`.
