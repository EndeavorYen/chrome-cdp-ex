# Where one CLI call's time goes (`cdp eval`, 2026-09-30)

Plan A, task 2. Measurement and analysis only: `skills/chrome-cdp-ex/scripts/cdp.mjs` is unchanged in this task's diff. Raw numbers are in [`2026-09-30-cli-preamble-data.json`](2026-09-30-cli-preamble-data.json).

Evidence labels: `local result` = measured here, `inference` = my reading of it, not tested.

## Setup

- Windows 11, Node v24.21.0, headless Chrome 154 started with `cdp spawn-debug-browser chrome --headless --port 9336` (own profile), one `about:blank` tab, `CDP_PORT=9336`. Nothing touched 9222 or 9224.
- Command under test: `cdp eval <target> document.title`, per-tab daemon already running (warm).
- Two instruments, because `--cpu-prof` only sees the CLI process's main thread and this call mostly waits:
  1. `scripts/profile-cli-call.mjs` (CPU profile, `topSelfTime`).
  2. A wall-clock probe preloaded with `node --import` from a scratch directory (wraps `net.Socket.connect/write`, `fetch`, `WebSocket`, `setTimeout`, logs `performance.now()`). It does not modify the repo. The probe itself costs a few ms.
- Ablations: scratch copies of `skills/chrome-cdp-ex` under `$TEMP` with one line changed each, run against their own daemon. The committed tree was never edited.

## Headline (`local result`)

Quiet-machine control on the committed tree, median of 12 warm runs: the process runs 228 ms from time origin to exit (248 ms wall as seen by the parent). Task 1's baseline of 331 ms median for `cdp eval` was taken on a busier machine (its p90 was 1252 ms). A `benchmark-cli-overhead` run in the same hour as this analysis gave `cdp eval` median 293 ms, `node -e 0` 44 ms, `cdp help` 104 ms. Percentages below use the 228 ms control as denominator (process-internal time; the ~20 ms of process spawn and teardown seen by the parent is outside it).

| Segment (ms since time origin) | ms | % of 228 | Kind |
|---|---|---|---|
| Node boot to first user code | 19.5 | 9% | irreducible |
| Load and compile `cdp.mjs` (26k lines) plus its `lib/` imports | 52.5 | 23% | synchronous CPU and file reads |
| Target discovery, 3 times (see below) | 78.5 | 34% | waiting on Chrome round trips |
| `collectDaemonMetadata` running `git rev-parse` via `spawnSync` | 17.5 | 8% | synchronous block waiting on a child process |
| `meta` + `eval` round trip to the daemon (0.3 ms on the pipe itself, ~3 ms end to end) | 2.8 | 1% | necessary IPC |
| After the `eval` reply, until the process can exit | 50.8 | 22% | pure wait, no CPU |
| Unattributed | ~5 | 2% | |

The per-call IPC that the plan called necessary is 1% of the call.

## Q1: how much of the extra time is synchronous CPU, how much waiting?

Split by wall timeline, not `process.cpuUsage` (187 ms, which also counts V8 and libuv helper threads and is not "sync CPU").

- Synchronous main-thread work: module load 52.5 + git block 17.5 = about 70 ms, roughly a third of the 209 ms after Node boots. The git block is a blocking wait on a child process, not compute.
- Waiting: discovery 78.5 + IPC 2.8 + shutdown tail 50.8 = about 132 ms, roughly two thirds. The tail is 0 CPU. Discovery is mostly network waits with some CPU in it (a lazy `undici` load costs ~12 ms of CPU on the first `fetch`), not split further.

CPU profile agrees (`local result`, top self time; `(idle)` is event-loop wait, `spawnSync`/`open`/`readFileUtf8`/`internalConnect` are blocking syscalls, not compute). Runs 2 and 3 were warm and quiet (285 ms total profile):

| # | function | where | ms (run 2 / run 3) | % |
|---|---|---|---|---|
| 1 | `(idle)` | | 124.5 / 123.8 | 45 / 43 |
| 2 | `spawnSync` (git) | child_process:1145 | 17.9 / 21.5 | 6.5 / 7.5 |
| 3 | `(program)` | | 12.3 / 14.8 | 4.5 / 5.2 |
| 4 | `compileSourceTextModule` | utils:317 | 11.0 / 10.7 | 4.0 / 3.7 |
| 5 | `open` (fs) | | 7.5 / 7.6 | 2.7 / 2.7 |
| 6 | `internalConnect` (run 2), second `compileSourceTextModule` (run 3) | net:1342 / utils:317 | 4.6 / 6.0 | 1.7 / 2.1 |
| 7 | `(garbage collector)` | | 3.0 / 4.5 | 1.1 / 1.6 |
| 8-10 | `readFileUtf8` x2, `(anonymous)` | cdp.mjs:1 | ~3 each | ~1 each |

Three further warm runs taken while the machine was busy (380-413 ms total): `(idle)` 128-132 ms (31-35%), `spawnSync` 25-37 ms (6-10%), `compileSourceTextModule` 15-17 ms. Run 1 of the first batch was a cold daemon (idle 717 ms of 892 ms: daemon spawn plus retry sleep) and is not part of the warm figures. No JS function of `cdp.mjs` owns self time above 1.2%: there is no compute hot spot, only waiting, blocking calls and load.

## Q2: which items reach 10%, and where they are

Denominator 228 ms.

1. **Discovery falls back to a fresh Chrome connection three times per call, because the daemon fast path is rejected (34%, 78.5 ms; about 66 ms of it avoidable, 29%).**
   - `discoverLivePagesForTargetResolution` (`cdp.mjs:22648`) first asks an existing daemon for the page list with `request(conn, { cmd: 'list_raw' })` at `cdp.mjs:22664`. The request has no `args`. The daemon validates with `snapshotApplicationArray(request.args, 'daemon request args')` at `cdp.mjs:672`, which rejects `undefined`. The probe shows the reply `{"ok":false,"error":"daemon request args is required"}` on every call, and the `catch {}` at `cdp.mjs:22668` swallows it. Same pattern at `cdp.mjs:25280` (`list`), `25437` (`target`), `25471` (`open --reuse`).
   - The fallback then runs `fetch /json/version` (`cdp.mjs:2217` `wsUrlFromCdpHttp`, `2254` `getWsUrl`), a browser WebSocket, `Browser.getBrowserCommandLine` (`rememberLiveCdpEndpointFromSession`, `cdp.mjs:1416`) and `Target.getTargets`. Measured spans, median: 35 / 23 / 19 ms.
   - It runs three times per call: `livePagesForTargetCommand` (`cdp.mjs:25774`), `supervisor.resolve` (`lib/browser-supervisor.mjs:261`) and `supervisor.refreshRecord` via `resolveDetail` (`lib/browser-supervisor.mjs:179`), both through `discover` at `cdp.mjs:25795`. With an alias that carries a port, the last two reuse `livePages` and skip it.
2. **Pipe close is delayed by about 51 ms after every daemon reply (22%, 50.8 ms).**
   - `requestDaemon` calls `conn.end()` after the reply (`lib/daemon-transport.mjs:224`; also `197`, `207`, `217` on error paths), not in `cdp.mjs`. The process cannot exit until the pipe closes.
   - The daemon replies in 0.3 ms (raw client, `pipe-rtt.mjs`); `close` arrives ~51 ms after `end()`. A stand-alone Node pipe server with no chrome-cdp-ex code shows the same: `end()` then close 50.8 ms, `destroy()` 0 ms. So it is a property of Node on this Windows pipe, not of the daemon (`inference`: libuv named-pipe graceful shutdown; not checked in libuv source). Not measured on Linux or macOS, where daemons use Unix sockets.
3. **Module load and compile (23%, 52.5 ms), synchronous.** It is the size of `cdp.mjs` and its imports. No item to fix in a function. A `NODE_COMPILE_CACHE` probe under load (`load-contaminated`) was inconclusive (87 / 112 / 92 ms) and is not counted. A cache would only help if set by a launcher before `cdp.mjs` itself is parsed (`inference`, untested).

Below 10%: the `git rev-parse` spawn in `currentGitCommit` (`cdp.mjs:2504`, called from `collectDaemonMetadata` `cdp.mjs:2526`, called at `cdp.mjs:25813`): 17.5 ms, 8%, and only when the skill sits inside a git checkout (an install without a `package.json` above it measured 1.4 ms). The `meta` + `eval` IPC (1%).

## Ablations (`local result`; each is one scratch line, not the committed tree)

Interleaved on the same daemon setup, n=12, package.json placed above each copy so git is spawned as in the real tree. `exit_at` is process-internal ms. r1 ran quiet; r2 ran under load, so only within-round comparisons mean anything.

| Variant | Change | r1 exit_at | r2 exit_at |
|---|---|---|---|
| v0 | control | 258.9 | 461.6 |
| vC | git spawn removed | 238.8 | 293.6 |
| vAB | A: `list_raw` sent with `args: []`; B: `conn.destroy()` after the reply | 126.4 | 131.6 |
| vAll | A + B + no git | 122.0 | 105.8 |

Earlier quiet single-change set (no package.json, so git was not spawned in any variant and vC is a null comparison there): control 218-226, A only 152, B only 168, A+B+C 117. A alone removes about 68 ms of discovery (83.5 to 12.3 ms) and B alone removes the 50 ms tail. Under load the same A+B saved about 195 ms of 400 in three interleaved rounds. Discovery cost scales with machine load; the 50 ms tail does not. Deduplicating discovery to one call (memo in a scratch copy) gave 46 ms against 80 ms on its first run; two repeats ran under load (53 and 69 ms) and are `load-contaminated`, so treat that figure as weak.

## Q3: can each item shrink without changing public behavior or contract fixtures?

- **Discovery fallback:** not proven safe to just add `args: []`. What I checked: `tests/action-exit-contract.test.mjs:816` only asserts `daemonRequestMayHaveSideEffects({ cmd: 'list_raw' })` is `false`, and `docs/contracts/*/runtime-dispatch.v1.json` list the route name `list_raw`, not the request shape. I did not run `npm run check:contracts`, so "no fixture change" is `inference`. Behavior risks that a fix must settle: the daemon route skips `rememberLiveCdpEndpointFromSession`, which the fallback runs each call (it records the live endpoint); and `findAnyDaemonSocket` takes the first cached page's daemon regardless of `CDP_PORT`, so with two browsers the daemon page list may belong to the other one (`inference`, untested; today the rejection masks it). The other route, deduplicating the three discoveries, changes when the drift check in `refreshRecord` happens. Either needs its own plan with a failing test.
- **Pipe close:** `tests/daemon-transport.test.mjs:76` asserts `conn.end` is called once after the reply, so the change touches an existing unit contract. Whether the daemon logs or mishandles a reset instead of a FIN was not tested.
- **Module load:** no small code change; the reduction path is untested.
- **Git spawn:** below threshold. A cheaper commit lookup would also change how staleness of a daemon is compared (`gitCommit` in the daemon metadata).

One intermittent failure while looping many calls under load: `WebSocket error: error` from the fresh Chrome connection made by the fallback, once; another `Cannot reach CDP ... timeout` at heavy load. Not reproduced on demand.

## Decision rule applied

Rule: only "synchronous CPU or unnecessary wait, at least 10% of the call" becomes a follow-up; each gets its own short plan with a failing test and `check:contracts` evidence. If the main cost were necessary IPC, the answer would be "CLI path cannot go lower, use `session.mjs`". That branch does not apply: necessary IPC is 1% of the call, and scratch copies with A+B reached 122-126 ms (`local result`, quiet).

Qualifying follow-ups, in order of measured saving:

1. Daemon page-list request is rejected and discovery runs three times: `cdp.mjs:22664` (also `25280`, `25437`, `25471`; cause `cdp.mjs:672`; repeats at `lib/browser-supervisor.mjs:179` and `261`, `cdp.mjs:25774`). About 66 ms, 29%.
2. Unnecessary wait for pipe shutdown after the reply: `lib/daemon-transport.mjs:224` (`197`, `207`, `217`). About 50 ms, 22%, Windows only as measured.
3. Module load and compile, 23% synchronous, qualifies by size but has no identified change; measure a launcher-set compile cache in a plan before assuming it.

Not qualifying: git spawn (`cdp.mjs:2504`, 8%), `meta`/`eval` IPC (1%), Node boot (9%).

`session.mjs` still removes the whole preamble for multi-step work, since it pays boot, load and discovery once. Fixing 1 and 2 leaves a single CLI call near 125 ms of process time on this machine (`inference`, from the ablation), which meets the plan's 150 ms target on a quiet machine.
