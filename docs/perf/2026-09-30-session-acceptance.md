# session.mjs live acceptance (2026-09-30)

Evidence level: `local result`. Browser: headless Chrome started by this task (`cdp spawn-debug-browser chrome --headless --port 9336`). Never connected to 9222 or 9224: the runs used `CDP_PORT=9336`, and the 8692841 runner already refused 9222 and 9224 (string compare). cf70339 added the refusal of an unset or empty `CDP_PORT`. Since e4d4e75 the scripts share `scripts/lib/port-guard.mjs`, which refuses unset, empty, non-integer, 9222 and 9224 compared as numbers (so `09222` too), and exits 2 before any spawn. Commits under test: both committed runs and the hidden-tab runs used the 8692841 runner scripts, against session library code (`session.mjs`, `lib/ws-transport.mjs`, `lib/cdp-session.mjs`) identical since b1b3ea4. The first acceptance run, committed in 3bb798c with the earlier runner (no wall-clock samples), measured a session receipt median of 66 ms and 12 CLI calls at a median of 2848 ms; 8692841 replaced that JSON, so its numbers survive only in 3bb798c. The final fix round (2402f96 library, e4d4e75 runner) changed port handling, `waitFor` timeouts, crash receipts and the runner's pass flags; these runs were not repeated after it. Scripts: `scripts/verify-session-live.mjs`, `scripts/verify-session-hidden.mjs`. Raw output: `2026-09-30-session-acceptance.json` (run 1), `2026-09-30-session-acceptance-run2.json` (run 2), `2026-09-30-session-hidden.json`.

## What each number measures

- `receipt ms, in-process`: the `ms` field inside the `session.mjs` JSON receipt. Measured inside the process, excludes Node startup and module load. The plan defines the pass threshold on this number.
- `wall-clock per process`: `Date.now()` around the whole `node session.mjs ...` invocation, includes Node startup. Comparable to the CLI number below.
- `12 CLI calls wall-clock`: `Date.now()` around 12 sequential `node cdp.mjs eval ...` processes, so it includes 12 Node startups.

## Result (two runs, same Chrome, same fixture)

| Measure | Run 1 | Run 2 | Threshold |
| --- | --- | --- | --- |
| 12 steps, session, receipt ms in-process (n=8) median | 63 (min 62, p90/max 283) | 65 (min 63, max 69) | <= 300, pass both |
| 12 steps, session, wall-clock per process (n=8) median | 103 (min 101, p90/max 329) | 106 (min 104, max 109) | not thresholded |
| Same 12 steps as 12 CLI calls, wall-clock (n=3) median | 3340 (min 2906, max 4012) | 2862 (min 2841, max 2950) | reference |
| Ratio CLI12 wall / session receipt | 53.0x | 44.0x | n/a |
| Ratio CLI12 wall / session wall (like for like) | 32.4x | 27.0x | n/a |
| `waitResponse` after_ms (300 ms delayed response) | 312 | 314 | <= 400, pass both |
| `pointer('#menu')` opened `pointerdown`-only menu | true | true | true |

Run 1 is labeled contaminated in its tail: one session sample took 283 ms receipt / 329 ms wall (a one-off spike; the machine is sometimes CPU-contended) and the CLI batches were 2906..4012 ms. The median still passes. Run 2 is clean. The honest speedup is the like-for-like wall-clock ratio, about 27-32x; the receipt ratio (44-53x) excludes the one Node startup that the session pays and is not a fair comparison.

## Deviation from the written script

The plan's script served the fixture from the measuring process and ran children with `spawnSync`, which blocks the event loop, so the fixture never answered (page never loaded, `Runtime.evaluate` timed out). The runner now uses async `spawn`, sequential. Fixture, steps, counts and thresholds are unchanged. Added: the port guard and the wall-clock samples.

## Hidden tab

Reproduced, 3 of 3 runs (`2026-09-30-session-hidden.json`). Each run: navigate the first tab to the fixture (menu closed), `cdp open about:blank` for a second tab, then read both tabs' `document.visibilityState`, then run `pointer('#menu')` through `session.mjs` on the first tab. In every run the first tab was `hidden` and the second `visible`; the receipt shows `visibility_before_pointer: "hidden"`, `menu_open_before: false`, `menu_open_after: true` (ok, 51-52 ms). So `pointer()` works on a hidden tab in headless Chrome. The second tab was closed between runs.

## Cleanup

`cdp stop` stops daemons only (the second run reported one daemon, ED1ADCB2, that failed to stop; stale, its tab was closed). Chrome was killed by pid with `taskkill /PID <pid> /F`; afterwards `netstat -ano | grep 9336` shows nothing, and no chrome.exe command line contains `cdp-accept-profile`. Temp dirs left in place.
