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
- **Stale daemon:** run the printed `stop <target>`, rerun the original command, and click Allow in Chrome only if Chrome actually showed the debugging prompt.
- **Port-bound alias eval says Allow in Chrome but prefix eval works:** the tab is already live. That error is a daemon-start failure, not a permission dialog. Re-run `cdp list` / `eval <prefix>`; do not restart Chrome or invent a new `--user-data-dir`.
- **Checkout outside expected skill path:** this is usually an install advisory, not an operational blocker.

## CDP not reachable

Dead CDP must fail fast with a same-profile relaunch receipt. Do not invent `DISPLAY`, a second `--user-data-dir`, or a fresh empty Chrome profile — that logs the user out of sites like X.

`list` and `doctor` already probe `http://127.0.0.1:9222/json/version` (spawn default) then `http://127.0.0.1:9224/json/version` when `CDP_PORT` and `DevToolsActivePort` are both missing. If either probe returns 200, the live tabs are listed — do not ask the user to toggle `chrome://inspect` or spawn a debug profile.

1. Read the printed `error=cdp_unreachable` receipt. If it includes a relaunch line, run that exact command (same port and `--user-data-dir`).
2. Check live targets:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs list
```

3. Unprefixed `doctor` probes `127.0.0.1:9222` before FAIL. If the **daily** debug Chrome is already there, set `CDP_PORT=9222` and continue with `list`. A leftover isolated `chrome-cdp-ex-*` profile on 9222 is not daily attach success — next probe is `--daily-profile` (ask first); do not kill the occupant without asking. If 9222 is empty, enable debug on the daily profile: `cdp spawn-debug-browser chrome --daily-profile --port 9222`. Isolated `spawn-debug-browser` is fallback only and is not the daily profile.
4. Prefer `--daily-profile` over `chrome://inspect/#remote-debugging` as the first human step. Use inspect only when the daily profile is unknown or `--daily-profile` cannot attach.
5. For an explicit port, set `CDP_PORT=<port>`:

```bash
CDP_PORT=9222 node skills/chrome-cdp-ex/scripts/cdp.mjs list
```

6. If the browser writes `DevToolsActivePort` somewhere non-standard, set `CDP_PORT_FILE` to the full path.
7. If no tab exists after CDP is reachable, open one:

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

Primary empty-port path: enable debug on the daily Chrome profile (logged-in tabs). Isolated spawn is fallback only and is not the daily profile. Follow doctor's preferred browser; on this Mac that is chrome, not hardcoded edge:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser chrome --daily-profile --port 9222
node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser chrome --port 9222 --url https://example.com
```

`--daily-profile` uses the browser's default user-data-dir and may quit/relaunch that Chrome if it is already running without debug. Isolated mode launches a separate user-data-dir and does not touch the user's main profile. In Linux CI, containers, or no-display shells, add existing flags shown by doctor such as `--headless`, `--no-sandbox`, or `--exe /path/to/browser` when needed.

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
