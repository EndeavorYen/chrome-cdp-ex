# session.mjs live acceptance (2026-09-30)

Evidence level: `local result`. Browser: headless Chrome started by this task (`cdp spawn-debug-browser chrome --headless --port 9336`, profile `%TEMP%/cdp-accept-profile`). Never connected to 9222 or 9224. Raw output: `2026-09-30-session-acceptance.json`. Script: `scripts/verify-session-live.mjs`. Head under test: b1b3ea4.

## Result

| Criterion | Threshold | Measured | Pass |
| --- | --- | --- | --- |
| 12 `page.ev` steps in one `session.mjs` call (n=8) | median <= 300 ms | median 66 ms (min 62, p90 71, max 71) | true |
| Same 12 steps as 12 `cdp eval` calls (n=3, baseline) | reference only | median 2848 ms (min 2837, max 2987) | n/a |
| `waitResponse` on a 300 ms delayed response | `after_ms` <= 400 | 323 ms | true |
| `pointer('#menu')` opens a `pointerdown`-only menu | result true | true | true |

Speedup of the 12-step sequence: about 43x (2848 / 66). Not the earlier 3,700 ms baseline: on this run the 12 CLI calls took 2.8 s, about 237 ms per call.

## Deviation from the written script

The plan's script served the fixture from the measuring process and ran children with `spawnSync`. That blocks the event loop, so the fixture never answered: the page never finished loading, `Runtime.evaluate` timed out, and `/late.bin` could not respond. The first attempt hung for that reason (stopped, no result recorded). The fix changes only the runner (`spawn` + await, sequential). Fixture, steps, counts and thresholds are unchanged.

## Hidden tab

Reproduced. Opening a second tab (`cdp open about:blank`) made the first tab report `document.visibilityState === "hidden"` (second tab `visible`). With the menu reset to closed and the tab still `hidden`, `page.pointer('#menu')` followed by a read returned `{"visibility":"hidden","menuOpened":true}` (receipt ok, 45 ms). So `pointer()` works on a hidden tab in headless Chrome. This was a single run, not repeated. The fixture server had already exited, so this used the DOM already loaded in the tab.

## Cleanup

`cdp stop` stopped 2 daemons only. Chrome (pid 37996) was killed with `taskkill /PID 37996 /F`; afterwards `netstat -ano | grep 9336` shows nothing and no chrome.exe command line contains `cdp-accept-profile`. Temp dirs (`session-live-*`, `cdp-accept-profile`) were left in place.
