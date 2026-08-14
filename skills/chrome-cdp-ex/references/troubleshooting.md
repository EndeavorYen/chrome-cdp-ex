# chrome-cdp-ex troubleshooting

Actionable recovery notes condensed from the exhaustive command reference. Prefer the command's printed `Recovery:`, `Run`, `Then`, and `Next:` lines when they are available.

## Start with doctor failures

Run:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor --format json
```

`doctor` checks Node 22+, skill install path, daemon sockets, open-file limits, runtime environment, CDP reachability, debuggable tabs, and browser permission. When multiple tabs are open, the next probe is `cdp list` (`N tabs — pick with cdp list / cdp target --url`); `list` is the source of truth for which tab, not a starred or first-daemon prefix. Treat the `Wizard` / `Recommendation` block as the setup path: run the printed command, ask for any explicit user action, then continue with `list`, `perceive <target> -C -d 8`, action, `perceive --since-action`, and `report`.

Common recoveries:

- **Node too old:** install/use Node.js 22+.
- **Low file descriptor limit:** run the printed `ulimit -n 4096`; on macOS, doctor may also print `sudo launchctl limit maxfiles 65536 200000` for GUI/login-session limits.
- **Stale daemon:** run the printed `stop <target>`, rerun the original command, and click Allow in Chrome if prompted.
- **Checkout outside expected skill path:** this is usually an install advisory, not an operational blocker.

## CDP not reachable

Dead CDP must fail fast with a same-profile relaunch receipt. Do not invent `DISPLAY`, a second `--user-data-dir`, or a fresh empty Chrome profile — that logs the user out of sites like X.

1. Read the printed `error=cdp_unreachable` receipt. If it includes a relaunch line, run that exact command (same port and `--user-data-dir`).
2. Check live targets:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs list
```

3. In a normal desktop browser, open `chrome://inspect/#remote-debugging` or `edge://inspect` and enable remote debugging/Allow when prompted. This is the correct path when the profile is unknown.
4. For an explicit port, set `CDP_PORT=<port>`:

```bash
CDP_PORT=9222 node skills/chrome-cdp-ex/scripts/cdp.mjs list
```

5. If the browser writes `DevToolsActivePort` somewhere non-standard, set `CDP_PORT_FILE` to the full path.
6. If no tab exists after CDP is reachable, open one:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs open https://example.com
```

## WSL2 controlling a Windows browser

When the agent runs in WSL2 and Chrome runs on Windows, use Windows-side Node.js. Do not spend attempts on WSL localhost, gateway IPs, port forwarding, launching Chrome from WSL, or WSL-side separate profiles.

```bash
powershell.exe -NoProfile -Command "(Get-Command node -ErrorAction SilentlyContinue).Source"
NODE_WIN="/mnt/c/Users/<you>/path/to/node.exe"
"$NODE_WIN" /path/to/skills/chrome-cdp-ex/scripts/cdp.mjs list
"$NODE_WIN" /path/to/skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

Chrome must be started by the user on Windows, with remote debugging enabled via `chrome://inspect/#remote-debugging`. Chain commands in one shell call when shell state will not persist.

## spawn-debug-browser

Use this only when the normal browser permission path is unavailable and the user consents to an isolated debug profile:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser edge --port 9222 --url https://example.com
```

The helper launches a separate user-data-dir with `--remote-debugging-port`; it does not touch the user's main profile. In Linux CI, containers, or no-display shells, add existing flags shown by doctor such as `--headless`, `--no-sandbox`, or `--exe /path/to/browser` when needed.

## Electron screenshot fallbacks

For Electron apps, launch with a remote debugging port and run commands with `CDP_PORT=<port>`:

```bash
CDP_PORT=9222 node skills/chrome-cdp-ex/scripts/cdp.mjs list
CDP_PORT=9222 node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

Some Electron builds time out on `Page.captureScreenshot`. The tool automatically falls back through `fromSurface:false` and a single-frame screencast grab, samples near-black frames, retries once when a light page was captured as black, and remembers the winning method for the session. If all screenshot paths fail, use `perceive`; it does not depend on screenshot support.

## Stale-ref and stale-daemon recovery

`@ref` handles are short-lived. Refresh them after navigation, DOM rewrite, modal open/close, restore, or any action classified as `stale-ref`:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

For long scripts and loops, use stable CSS selectors instead of old refs. If an action still fails, follow the classified recovery:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs overlay <target> @5
node skills/chrome-cdp-ex/scripts/cdp.mjs frame <target> --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs status <target>
node skills/chrome-cdp-ex/scripts/cdp.mjs report <target>
```

A `stale-daemon` means the script or checkout changed after the per-tab daemon started. Run the printed stop command, then rerun the original command:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs stop <target>
```

Use `--allow-stale-daemon` only for an intentional long-running daemon and only as a one-off bypass.

## Focused search poisons perceive

If a search/typeahead is focused, `perceive` may dump suggestions instead of the article. Blur first (`press Escape`) or `perceive -s main`. Use `--keep-typeahead` only when inspecting the dropdown.
