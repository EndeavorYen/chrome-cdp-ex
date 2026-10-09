# Phase D: Haiku 5.5 probe

Each of the twelve Phase C scenarios ([scenarios.md](scenarios.md)) was given once to Claude Haiku 5.5 (`claude-haiku-5-5`; every run reported this id) on 2026-10-09, against chrome-cdp-ex 2.21.0 at `21e96b5`. The scenario judges scored every run; the reference paths are the oracle for cost. Raw, sanitized data: [haiku-probe.json](haiku-probe.json), built by `node docs/audit/probe-metrics.mjs <probeDir> --json --all`.

## Method

What the model had:

- SKILL.md, verbatim (7,401 chars), as the skill text.
- One host-overlay paragraph: the skill's `bin/chrome-cdp` (written `cdp` in examples and output) is installed as `.probe/NN/chrome-cdp` and is already connected to the user's browser.
- Rules: use only that CLI, through Bash; no other browser tools (Playwright, MCP browser tools); do not read the repository's files; files the CLI says it wrote (screenshots, downloads) may be opened.
- The user's words. The CLI's own `--help` and `help <command>` were available.

What it did not have: references/, the Phase B findings, hints about traps.

Harness:

- Each scenario ran with `--prepare` (disposable headless Chrome, loopback apps). A logging wrapper recorded every CLI call (arguments, exit code, duration, stdout, stderr), and the scenario judge scored the final answer together with that transcript.
- Safety: the wrapper always set the scenario's `CDP_PORT` and runtime directory, whatever the caller passed. For the duration of the probe a temporary guard at the top of `cdp.mjs` refused any run without the wrapper's token, so a model calling `bin/chrome-cdp` directly could not reach the user's own Chrome or Edge. The guard was removed afterwards (`git checkout`), and `cdp.mjs` is unchanged. Guard hits during agent runs: 0. Runs that set any `CDP_*` variable themselves: 0.
- One attempt per scenario, no coaching, a cap of 30 CLI calls per run (no run was stopped by it; scenario 6 used exactly 30).
- Runs went in parallel batches of three or four. CLI timings include that contention; model time dominates either way.

Prompt versions: the first prompt said "One attempt: if you cannot finish, stop and tell the user what happened". In scenario 3 Haiku read that as "only one action is allowed" and stopped after the first refused click. From then on the line read "If you get stuck and cannot finish, stop and tell the user what happened" (v2); scenario 3 was re-run under v2 and 4–12 ran under it. Scenarios 1 and 2 ran under v1 and never got stuck, so the wording did not come into play.

## Results

| # | Scenario | Result | CLI calls (reference) | Failed calls | `help` | `eval` | Next followed | Chars read (~tokens) | CLI s / model s | Agent tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | admin session setting | pass | 15 (6) | 0 | 4 | 3 | 1/1 | 6,708 (~1,677) | 5.8 / 49.7 | 59,558 |
| 2 | SPA search → detail | pass | 10 (6) | 0 | 1 | 0 | 0/0 | 6,846 (~1,712) | 4.0 / 25.5 | 54,786 |
| 3 | modal blocks approve | pass (v2) | 10 (6) | 1 | 0 | 0 | 1/1 | 11,977 (~2,994) | 3.6 / 43.1 | 62,919 |
| 4 | validation fix + resubmit | pass | 17 (10) | 0 | 3 | 2 | 1/1 | 6,590 (~1,648) | 7.8 / 35.6 | 57,026 |
| 5 | same-title tabs | pass | 7 (4) | 0 | 0 | 0 | 1/1 | 4,617 (~1,154) | 6.0 / 22.4 | 53,525 |
| 6 | cross-site iframe payment | pass | 30 (8) | 1 | 9 | 2 | 1/4 | 9,301 (~2,325) | 9.8 / 96.5 | 86,537 |
| 7 | virtual list, nested scroll | pass | 13 (4) | 1 | 4 | 2 | 0/1 | 7,231 (~1,808) | 3.1 / 67.5 | 64,890 |
| 8 | export download, session | pass | 12 (3) | 0 | 5 | 0 | 0/0 | 9,282 (~2,321) | 4.2 / 51.7 | 63,065 |
| 9 | visual diff of widgets | pass | 16 (5) | 0 | 3 | 7 | 1/1 | 37,106 (~9,277) | 8.9 / 131.7 | 82,561 |
| 10 | console error + source map | pass (re-judged) | 12 (3) | 1 | 2 | 5 | 1/2 | 7,024 (~1,756) | 5.1 / 75.5 | 76,609 |
| 11 | 503 then retry | pass (re-run) | 16 (7) | 1 | 2 | 0 | 2/5 | 7,855 (~1,964) | 4.7 / 34.2 | 57,976 |
| 12 | WebGL heatmap | pass (re-judged) | 11 (2) | 1 | 4 | 1 | 0/1 | 2,992 (~748) | 2.3 / 60.6 | 62,610 |
| | **Total** | **12/12** | **179 (64)** | **6** | **37** | **22** | **9/18** | **117,529 (~29,400)** | **65 / 694** | **782,062** |

- "Model s" is the time between the first and the last CLI call minus the CLI time. "Agent tokens" is the runtime's total for the run; most of it is the fixed context (instructions, SKILL.md, tool definitions) re-read on every turn, not CLI output.
- Re-judged and re-run rows are explained in [scenarios.md, Corrections made during Phase D](scenarios.md#corrections-made-during-phase-d): two judge bugs (10, 12) were fixed and the same answers re-scored; one fixture bug (11) voided a run, which was repeated.
- No run invented a flag or a command. One call missed required arguments (`fill <t>` in 11, `Kind: usage`).

Archived runs, not in the totals:

| Run | Result | Calls | Why it is archived |
|---|---|---|---|
| 01 smoke | pass | 13 | The auditor edited `cdp.mjs` during the run; the tab daemon reported itself stale once, Haiku ran `stop` and retried. |
| 03 v1 | fail (`not-approved`) | 5 | Prompt v1. Haiku hit `Kind: covered`, refused the Next line's `--js` ("it would approve through the dialog"), did not press "Stay signed in", and asked the user to choose. |
| 11 void | (judged pass, void) | 23 | Fixture bug: `/profile` never showed the saved name, so Haiku concluded the save had failed. It also re-sent the POST from the page with `eval fetch`, copying the app's client header from `netlog`. |

## What the runs show

**The Phase B traps rarely caught Haiku 5.5; where the tool is wrong, it paid in calls, or misinformed the user.**

| Trap (finding) | What Haiku did | Cost |
|---|---|---|
| `select @ref` fails (B-02, #633) | Used `#timeout` / `#month`, the CSS selectors that `perceive -C` lists under `[Visible controls]` (1, 4, 8) | none; those selector lines are what made it work |
| `press Enter` clicks a "results" link (B-01, #632) | Clicked the Search button instead (2) | none |
| Covered click, Next `click --js` (#601) | Refused `--js` both times; under v2 pressed "Stay signed in" first (3) | v1 stopped and asked the user |
| Cross-site iframe clicks reported as failures (B-08, #639) | Did not retry; took screenshots to check focus, then moved with Tab and submitted with Enter (6) | 30 calls vs 8, 6 screenshots, 9 `help` calls |
| Directional scroll ignores the nested scroller (B-09, #640) | `scroll … down 6400 --scroll-container #viewport` was refused ("only valid with to top/to bottom", `Kind: unknown`); `scroll … down 6400` reported success and moved nothing; then `eval` set `scrollTop` (7) | 2 wasted calls, `eval` workaround |
| Download link without `--expect-download` (B-08) | Used `click … --expect-download --out DIR`, learned from SKILL.md; noted that `click --help` does not list those flags (8) | none |
| `no-store` response body unreadable (B-15, #648) | Read status and Retry-After, retried after the wait, then told the user "the response body was empty, the server gave no reason" (11) | a wrong statement to the user: the body said "upstream timeout" |
| CSS-only theme change (scenario 9) | Hashed computed styles of every card before and after the click with `eval` | 37,106 chars, 25× the reference path's 1,483 |

**Next lines were followed 9 times out of 18, and not following them was often right.** The two ignored Next lines in scenarios 3 and 6 were the harmful ones (`click --js` through a modal, `jsclick` into a payment iframe). A probe that scores obedience as good would have scored the safer behaviour as worse.

**Overheads that never changed an outcome:**

- 37 `help` calls, 9 of them in scenario 6.
- `doctor` as the first command in 6 of 12 runs, at 1.4–2.1 s each.
- `stop` after finishing in 6 runs.
- 28 `perceive` calls, nearly all `-C -d 8` at 0.8–2.9 K chars each; one was redundant.

**Cost relative to the reference paths:** 2.8× the calls and 5.0× the chars. Time is almost all model time: the CLI took 65 s of 759 s, under 9 %.

**Behaviour worth keeping:**

- The models stayed inside the CLI.
- They explained refusals: `--js` in 3, and in 6 a warning not to press Pay again.
- They flagged things the user should know: an outlier invoice in 8, the hard-coded subtotal in 10, self-approval in 3.

## Re-runs after proposals 1 to 3

Scenarios 4, 7 and 11 were run again once each, with the same prompt (v2), the same SKILL.md and the same safety guard. The CLI was the only change ([proposals.md, Results](proposals.md#results-of-1-to-3); data: [haiku-probe-after.json](haiku-probe-after.json)).

| # | Result | Calls | Chars | Failed calls | `help` | `netlog` | Model s |
|---|---|---|---|---|---|---|---|
| 4 | pass → pass | 17 → 12 | 6,590 → 4,280 | 0 → 0 | 3 → 0 | 0 → 0 | 35.6 → 25.5 |
| 7 | pass → pass | 13 → 12 | 7,231 → 6,332 | 1 → 0 | 4 → 3 | 0 → 0 | 67.5 → 41.2 |
| 11 | pass → pass | 16 → 13 | 7,855 → 6,136 | 1 → 0 | 2 → 2 | 5 → 0 | 34.2 → 43.5 |

- **Scenario 11.** The answer gives the 503, "upstream timeout" and Retry-After 2 from the click receipt. The first run had told the user that the body was empty.
- **Scenario 4.** After the 422 receipt Haiku fixed the field without a `perceive`.
- **Scenario 7.** The first `scroll … --scroll-container #viewport` moved the list.

Guard hits during the agent runs: 0. Agent-set `CDP_*` variables: 0. With one run per arm, only scenario 4's drop in calls is larger than the 2-call spread between the two identical scenario 1 runs.

## Limits

- One run per scenario, one model, one machine; runs in parallel batches.
- The judges' direct-API check relies on the app's client header. The void scenario 11 run copied that header from `netlog`, so a clean `direct-api` result is a lower bound on such calls.
- Whether a model read repository files cannot be observed; the rules forbade it and no answer shows knowledge outside SKILL.md and the CLI output.
- Image reading (screenshots in 6 and 12) is not in the chars column; the images were read with the model's own file tool.
