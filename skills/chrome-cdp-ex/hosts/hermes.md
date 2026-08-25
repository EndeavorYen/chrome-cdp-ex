# Hermes host overlay

Use the main `../SKILL.md` instructions and invoke the CLI directly from shell.

Standalone skill install: `~/.hermes/skills/chrome-cdp-ex`, or
`$HERMES_HOME/skills/chrome-cdp-ex` when `HERMES_HOME` is set.

```bash
node scripts/setup.mjs --for hermes --write
node ~/.hermes/skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node ~/.hermes/skills/chrome-cdp-ex/scripts/cdp.mjs list
node ~/.hermes/skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

For Electron or a fixed DevTools endpoint, prefix commands with `CDP_PORT=<port>`.
Daily Chrome/Edge in this project stays on **9222**. Electron apps must use a
**different** port so `doctor` / `spawn` do not occupy 9222. Example:

```bash
CDP_PORT=9333 node ~/.hermes/skills/chrome-cdp-ex/scripts/cdp.mjs list
```
