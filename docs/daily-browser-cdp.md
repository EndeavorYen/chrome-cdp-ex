# Daily browser CDP (Chromium 136+)

From Chrome 136, `--remote-debugging-port` and `--remote-debugging-pipe` are ignored on the browser's **default** user-data-dir ([Chrome security change](https://developer.chrome.com/blog/remote-debugging-port)). Edge inherits this. A process can show the flag in `edge://version` and still listen on nothing.

chrome-cdp-ex cannot silently attach to an already-running Dock or default Chrome or Edge (no debug port, default profile) without quitting that browser or asking a human to click Allow. Isolated spawn is not that session. Detecting the failure is not a fix. See [#368](https://github.com/EndeavorYen/chrome-cdp-ex/issues/368).

## What this project does

Use a **fixed** non-default user-data-dir, always started with remote debugging. Sign in once in that dir. Later launches of the same dir keep the login. Re-login only if the dir is deleted, the path changes, or the site expires the session.

Do not target Dock or default Edge. Do not kill it. Do not wait for an inspect Allow click.

`--daily-profile` still means the **browser default** dir. That path cannot enable CDP on 136+. Do not use `--daily-profile` as a substitute for the persistent dir below.

Empty 9222: `doctor` first step is that persistent dir (ask first), not `--daily-profile`, not `/tmp` isolated, not inspect Allow.

## Attach

Pick one machine-local path and keep it. macOS Edge example:

```bash
DIR="$HOME/Library/Application Support/chrome-cdp-ex/daily-edge"
mkdir -p "$DIR"
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --user-data-dir="$DIR" \
  --remote-debugging-port=9222 \
  --no-first-run
./bin/chrome-cdp doctor
./bin/chrome-cdp list
```

Or:

```bash
./bin/chrome-cdp spawn-debug-browser edge --port 9222 --user-data-dir "$DIR"
```

## Other approaches

| Approach | Zero click? | Keeps Dock/default cookies? | Survives restart without re-login? | Cron / unattended? | Notes |
|---|---|---|---|---|---|
| 1. Silent CDP on already-open **default** profile | Yes | Yes | n/a | Would be ideal | Impossible on Chromium 136+. Not a chrome-cdp-ex bug. |
| 2. Persistent non-default dir **as the daily browser**, always launched with `--remote-debugging-port` | Yes after first launch | No. This dir **is** daily for the agent | Yes (same dir) | Yes | One-time sign-in in that profile. Dock default Edge/Chrome is no longer the attach target. Do not delete the dir. |
| 3. Chrome 144+ `chrome://inspect/#remote-debugging` (Allow dialog) | No. Click every connect | Yes if the UI exists | n/a | No | Unusable for cron. Edge 151 has no proven equivalent silent API. |
| 4. Fresh isolated `--user-data-dir` under `/tmp` each run | Yes | No | No | Only after re-login every run | Fine for throwaway automation. Not daily. |
| 5. Second always-on debug window, leave Dock Edge untouched | Yes after first launch | No (copy of login in the second profile) | Yes | Yes | Same mechanism as (2), but daily human browsing stays on default. Two browsers. |

This project uses approach 2.
