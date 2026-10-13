# Daily browser CDP (Chromium 136+)

The first step for the user's own browser is the `chrome://inspect/#remote-debugging` toggle (Edge: `edge://inspect`). That keeps their logins, including the default profile. Then `./bin/chrome-cdp doctor` and `./bin/chrome-cdp list`.

From Chrome 136, `--remote-debugging-port` and `--remote-debugging-pipe` are ignored on the browser's **default** user-data-dir ([Chrome security change](https://developer.chrome.com/blog/remote-debugging-port)). Edge inherits this. A process can show the flag in `edge://version` and still listen on nothing. Leave Dock and default Chrome or Edge running. The inspect toggle is what enables CDP on that profile. See [#635](https://github.com/EndeavorYen/chrome-cdp-ex/issues/635) and [#368](https://github.com/EndeavorYen/chrome-cdp-ex/issues/368).

`spawn-debug-browser`, `--daily-profile`, and an isolated or persistent non-default profile are fallbacks. Each is a profile without the user's logins. Ask first. `--daily-profile` still means the **browser default** dir, where Chrome 136+ ignores `--remote-debugging-port`.

When nothing answers on the probe ports, `doctor` names `chrome://inspect/#remote-debugging` first, then `CDP_PORT=<port>` for Electron or a browser on its own port. It says the spawn suggestion is a profile without the user's logins.

## Persistent dir (fallback / cron)

A fixed non-default user-data-dir, always started with remote debugging, is the fallback that can run unattended. It does not have the user's existing logins. Sign in once in that dir. Later launches of the same dir keep that login. Sign in again only if the dir is deleted, the path changes, or the site expires the session.

Pick one machine-local path and keep it. macOS Edge example:

```bash
DIR="$HOME/Library/Application Support/chrome-cdp-ex/daily-edge"
mkdir -p "$DIR"
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --user-data-dir="$DIR" \
  --remote-debugging-port=9222 \
  --disable-backgrounding-occluded-windows \
  --no-first-run
./bin/chrome-cdp doctor
./bin/chrome-cdp list
```

`--disable-backgrounding-occluded-windows` keeps a window that other windows cover rendering. Commands run in background mode and never raise the browser, so the agent's window often sits behind your other apps; without the flag Chrome can mark it hidden, and clicks there become slow or are dropped. The cost: covered windows keep painting (some CPU). Background tabs are still throttled. `spawn-debug-browser` passes this flag by default (`--allow-occlusion` turns it off).

Or:

```bash
./bin/chrome-cdp spawn-debug-browser edge --port 9222 --user-data-dir "$DIR"
```

## Other approaches

| Approach | Zero click? | Keeps the user's logins? | Survives restart without re-login? | Cron / unattended? | Notes |
|---|---|---|---|---|---|
| 1. `chrome://inspect/#remote-debugging` (Edge: `edge://inspect`) on the browser already open | Turn the toggle on | Yes, including the default profile | While that browser stays open | No | First step. |
| 2. Persistent non-default dir, always launched with `--remote-debugging-port` | Yes after first launch | No. Sign in once in that dir | Yes (same dir) | Yes | Fallback. Ask first. |
| 3. `--daily-profile` | No on Chrome 136+ | No. The port does not come up on the default dir | n/a | No | Fallback. The flag is ignored on the default user-data-dir. Ask first. |
| 4. Fresh isolated `--user-data-dir` under `/tmp` | Yes | No | No | Only after signing in every run | Fallback for throwaway automation. Ask first. |
| 5. `spawn-debug-browser` | Yes after launch | No | With a persistent dir | Yes, with that dir | Same fallback family. Ask first. |

The first step is approach 1. Approach 2 is the launch line above.
