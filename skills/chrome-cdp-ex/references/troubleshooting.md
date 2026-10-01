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

`list` and `doctor` already probe `http://127.0.0.1:9222/json/version` (spawn default), then `http://127.0.0.1:9224/json/version`, then the port chrome-cdp-ex last reached, when `CDP_PORT` and `DevToolsActivePort` are both missing. If a probe returns 200, the live tabs are listed — do not ask the user to toggle `chrome://inspect` or spawn a debug profile. Both commands share this discovery, so they give the same diagnosis and the same `Next:` line.

1. Read the printed `error=cdp_unreachable` receipt. If it includes a relaunch line, run that exact command (same port, profile and launch flags such as `--headless=new` / `--no-sandbox`, and `--background` for a background spawn; on Linux without `DISPLAY` it always has `--headless=new`). The receipt names the persistent profile last used on that port, preferring a persistent profile over a temp one, and lists any other candidates; when `cdp spawn-debug-browser ... --profile-dir` created the port it is that command, not a raw browser line.
   If the receipt is `profile-in-use` (`cdp_profile_in_use`), that profile's browser is still running: do not relaunch it (a second launch only hands off to the running browser). Run the printed `CDP_PORT=<port> cdp list` when it has a debugging port; otherwise enable remote debugging in it, or ask the user to quit it, then rerun `cdp doctor`.
2. Check live targets:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs list
```

3. Unprefixed `doctor` probes `127.0.0.1:9222` before FAIL. If a **live tab daemon** already exists (Electron or a previous `perceive`), that session is usable — next probe is `cdp perceive <prefix>` or `CDP_PORT=<port> cdp doctor` / `cdp list`. Do not occupy 9222, including when 9222 is a leftover isolated occupant. If the **daily** debug browser is already on 9222, set `CDP_PORT=9222` and continue with `list`. A leftover isolated `chrome-cdp-ex-*` profile on 9222 is not daily attach success — if no tab daemon is live, next probe is the persistent daily dir (ask first); do not kill the occupant without asking. If 9222 is empty **and no tab daemon is live**, enable debug on the persistent daily dir (ask first). Isolated `spawn-debug-browser` is fallback only and is not the daily profile. `spawn-debug-browser --help` must not launch a browser.
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

Primary empty-port path: enable debug on the daily browser profile (logged-in tabs). Isolated spawn is fallback only and is not the daily profile. Follow doctor's `preferredBrowser` (macOS default HTTP handler when Edge/Chrome/Brave; not hardcoded chrome or edge):

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser --help
node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser <preferredBrowser> --daily-profile --port 9222
node skills/chrome-cdp-ex/scripts/cdp.mjs spawn-debug-browser <preferredBrowser> --port 9222 --url https://example.com
```

`--help` / unknown flags print help and must not launch a browser. `--daily-profile` uses the browser's default user-data-dir. `Opening in existing browser session` / `在現有的瀏覽器工作階段中開啟` is failure, not attach success. Chrome 136+ / Edge ignore `--remote-debugging-port` on the default user-data-dir, so `--daily-profile` does not quit+relaunch that same default profile as if 9222 would come up. Isolated mode launches a separate user-data-dir (fallback only, not the daily profile; cookies will not transfer). In Linux CI, containers, or no-display shells, add existing flags shown by doctor such as `--headless`, `--no-sandbox`, or `--exe /path/to/browser` when needed.

## Clicks and keys do nothing (hidden tab)

If `click`/`clickxy` fails with `Kind: no-input-events`, or `press Enter` silently does nothing, check `document.visibilityState`:

```bash
cdp eval <target> "document.visibilityState"
```

`hidden` means the tab is a background tab, or its browser window is covered by another window or minimised (Windows occlusion tracking); Chrome then drops `Input.*` events. Neither `Page.bringToFront` nor `Target.activateTarget` uncovers a covered window (Windows does not let Chrome raise itself). Background mode, the default, never brings a tab forward. Options: bring the window to the front yourself; for a background tab, rerun with `CDP_BACKGROUND=0` (activates the tab before the command); use `cdp jsclick` (page-side `element.click()`); or launch the browser with `--disable-backgrounding-occluded-windows` (see `docs/daily-browser-cdp.md`), which keeps covered windows rendering. `spawn-debug-browser` passes that flag and `--disable-features=CalculateNativeWinOcclusion` by default (`--allow-occlusion` opts out).

The failure receipt says `dispatched: false` for `no-input-events` (the page saw nothing) and `dispatched: "unknown"` for `timeout`. After a timeout, run `cdp perceive <target> --since-action` before resending a non-idempotent action.

## Click fails with `Kind: covered`

The mouse `click` hit-tests the target's centre first. `covered` means another element is on top there, so a real
click would land on it; nothing was sent (`dispatched: false`). The `Error:` line names the covering element and its
fixed/sticky container. If it is a dialog, close it (`cdp dismiss-modal <target>`) and click again. If it is page layout
such as a fixed sidebar or sticky header (common in narrow headless windows), use `cdp click <target> <sel> --js`, or
widen the window with `cdp viewport`. `cdp overlay <target> <sel>` shows what covers the target.

## Electron screenshot fallbacks

For Electron apps, launch with a remote debugging port and run commands with `CDP_PORT=<port>`:

```bash
CDP_PORT=9222 node skills/chrome-cdp-ex/scripts/cdp.mjs list
CDP_PORT=9222 node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

Some Electron builds time out on `Page.captureScreenshot`, and on Windows some refuse `fromSurface:false` (`Unable to capture screenshot`; the app logs `Failed to print window`). The tool falls back through `fromSurface:false` and a single-frame screencast grab, and retries once when a region the DOM paints light was captured as black (canvas, video, and image regions are not judged). Each command starts again at the plain `Page.captureScreenshot`. If all screenshot paths fail, the error lists each tier with its CDP error (`Kind: screenshot-capture`); use `perceive`, which does not depend on screenshot support.

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

## Daemon crashed mid-command

`Connection closed before response: the daemon for this tab crashed (…)` names the uncaught error that ended the tab daemon; the record is `cdp-<target>.crash.json` in the runtime dir. Re-run `perceive <target>` to start a fresh daemon, and include that line when reporting the bug.
