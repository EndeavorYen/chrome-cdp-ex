# PK: musk/live-path vs un-deleted main (`c332afc`)

Issue [#384](https://github.com/EndeavorYen/chrome-cdp-ex/issues/384). Parent [#375](https://github.com/EndeavorYen/chrome-cdp-ex/issues/375). Protocol: this branch vs un-deleted main, not vs Browser Use.

Board 1 measured 2026-08-28 on the shrink tree that became `83b9bdd`. Board 2 measured 2026-08-28 on Mini (Edge 151, `CDP_PORT=9222`, 1042×632, n=3 median) and copied from [#384 comments](https://github.com/EndeavorYen/chrome-cdp-ex/issues/384) — not remeasured here.

## What was compared

| Side | Identity |
|---|---|
| `c332afc` | `git show c332afca49296a55a16fc82008c98fc6506177f9` (v2.16.0 + unreleased daily-CDP docs). Un-deleted main when `musk/live-path` was cut. |
| musk/live-path | `83b9bdd67bef1581e9db70065deab952f0ed82c9` (`refactor: shrink live operator surface (#375)`). Board 1 numbers are from this tree. |

No rebase onto later main. Board 1 help/doctor baseline files were extracted with `git archive c332afc` into `%TEMP%\c332afc-chrome-cdp-ex` and executed there. Board 2 used Mini worktrees `/tmp/chrome-cdp-ex-384-main` @ `c332afc` and `/tmp/chrome-cdp-ex-384-musk` @ `83b9bdd`.

## Board 1 — operator surface

Tokenizer (same tool both sides): UTF-8 byte length of the file, plus whitespace-separated tokens (`text.trim().split(/\s+/)`). Help/doctor char counts are JavaScript `string.length` of default stdout (UTF-8 bytes also recorded).

| Face | How | `c332afc` | musk/live-path |
|---|---|---:|---:|
| Always-loaded `SKILL.md` UTF-8 bytes | `git cat-file -s` vs `fs.readFileSync` | 15785 | 4174 |
| `SKILL.md` chars | `toString('utf8').length` | 15706 | 4160 |
| `SKILL.md` whitespace tokens | tokenizer above | 2276 | 614 |
| `SKILL.md` lines (`split(/\r?\n/)`) | includes trailing empty from final newline | 75 | 52 |
| Commands named on the card (SKILL high-signal) | remember / Survivors backtick list | **27** | **20** |
| Default `node skills/chrome-cdp-ex/scripts/cdp.mjs help` chars | stdout | 24644 | 1676 |
| Default help UTF-8 bytes | `Buffer.byteLength` | 24662 | 1676 |
| Default help lines | stdout split | 274 | 38 |
| Default help unique command names | first token of indented synopsis rows; baseline footer prose excluded | **81** (+ `help`) | **21** (`help` + 20 survivors) |
| Default `cdp doctor` chars | stdout, no browser | 1798 | 123 |
| Default doctor UTF-8 bytes | same run | 1800 | 123 |
| Default doctor lines | stdout split | 38 | 4 |
| Golden-path steps | attach → perceive → one act → receipt | 5 (fat step 4–5) | 5 (skinny) |
| Default action stdout (`nav` / `click` / `scroll to bottom`) | live happy path | **NOT MEASURED this run** | **NOT MEASURED this run** |

SKILL high-signal names:

- `c332afc` remember list: `doctor`, `list`, `open`, `nav`, `target`, `use`, `perceive`, `eval`, `call`, `click`, `fill`, `press`, `select`, `scroll`, `verify-click`, `dismiss-modal`, `overlay`, `frame`, `cascade`, `inject`, `elshot`, `shot`, `scanshot`, `record`, `waitfor`, `report`, `stop`.
- musk Survivors (matches `SURVIVOR_COMMANDS`): `doctor`, `list`, `open`, `nav`, `perceive`, `text`, `click`, `fill`, `press`, `select`, `scroll`, `eval`, `inject`, `cascade`, `waitfor`, `dismiss-modal`, `elshot`, `shot`, `spawn-debug-browser`, `stop`.

`click --js` is a flag, not `jsclick`. `eval --b64` is a flag, not `eval64`. Default musk help does not advertise those product names.

### Golden-path steps

Same 5-step skeleton. Content of the card is what shrank.

| Step | `c332afc` | musk/live-path |
|---|---|---|
| 1 | Doctor (Node, install, daemon, fd, CDP, permission) | Doctor or list (Node, install, daemon, CDP, permission) |
| 2 | List/open; `target --url`; leftover `perceive <id> -C -d 8` sample warned off | List / open / nav. Isolated `spawn-debug-browser` is fallback — ask first |
| 3 | `perceive -C -d 8`; `text --auto` | `perceive -C -d 8`; `text --auto` |
| 4 | Act plus HuggingFace `/models?search=`, leftover-AX, cap-swap, `jsclick`, `batch --compact` | Act: `click`/`fill`/`press`/`select`/`scroll`/`dismiss-modal`; `click --js` and `eval --b64` as flags |
| 5 | Verify/report: `verify-click`, `perceive --since-action`, `report` | One-line action receipt (URL, outcome, next). Then `stop` |

Chrome 136 daily-profile physics and Electron `CDP_PORT=9333` (not 9222) stay on the musk card as short notes.

### Default help / doctor stdout (no browser)

Both CLIs were invoked on this machine with `/json/version` on 9222 unreachable.

`c332afc` doctor is the wizard novel: Status / Current step / Golden path / Recommendation / Checks / Next steps (1798 chars). musk doctor is three payload lines (123 chars):

```
Node: v22.22.0 (>= 22)
CDP: DevToolsActivePort points to 9222 but /json/version unreachable: fetch failed
Next: cdp doctor
```

Note: with CDP down, musk `Next` still says `cdp doctor` rather than `list` or spawn-with-ask (#383 wanted the latter). The essay is gone; the next-command string is still a doctor loop.

Live `nav` / `click` / `scroll to bottom` stdout was not collected (no reachable CDP). Unit-test contracts on this tree (`tests/nav-compact-receipt.test.mjs`, `tests/scroll-compact-receipt.test.mjs`) already require skinny default text: click `Clicked #save. Next: cdp list`; nav URL+title without Outcome/Receipt/Verdict; document-scroll-edge `scrollY` / `scrollMax` / `at-bottom` without Recovery/Hint. Those are not live n=3 measurements.

## Board 2 — #324 jobs vs itself

Measured 2026-08-28 on Mini. Daily Edge `CDP_PORT=9222` Edg/151.0.4129.107. Viewport **1042×632** (`viewport <target> 1042x632`; `innerWidth×innerHeight` confirmed 1042×632 both SHAs). n=3 median. Effect = majority of 3 (≥2 PASS). Steps = measured action only after `nav` / `viewport` / `scroll to top` setup. Chars = Unicode length of that action's stdout. Wall ms = `perf_counter` around that `node` process (search-submit musk = sum of fill+press).

Copied from [#384 batch 1](https://github.com/EndeavorYen/chrome-cdp-ex/issues/384#issuecomment-5447843583), [batch 2](https://github.com/EndeavorYen/chrome-cdp-ex/issues/384#issuecomment-5447910838), and [batch 3](https://github.com/EndeavorYen/chrome-cdp-ex/issues/384#issuecomment-5448015514). Not remeasured on this VM. 9333 not used. No isolated spawn. Dock browser not quit. `batch` was not added back.

Columns: `c332afc` | `83b9bdd`. Cells: effect / steps / chars / wall ms.

| job | `c332afc` | `83b9bdd` |
|---|---|---|
| scroll to bottom (HF home) | PASS / 1 / 62 / 133 | PASS / 1 / 62 / 131 |
| nested overflow (Comfy `#content-container`) | PASS / 1 / 83 / 105 | PASS / 1 / 83 / 102 |
| click Browse 2M+ models | PASS / 1 / 545 / 431 | PASS / 1 / 86 / 452 |
| search submit bert | PASS / 1 / 114 / 403 | PASS / 2 / 160 / 1544 |
| nav example.org | PASS / 1 / 69 / 146 | PASS / 1 / 69 / 144 |
| read HF home | PASS / 1 / 3899 / 101 | PASS / 1 / 3899 / 100 |
| hover reveal | PASS / 1 / 66 / 197 | PASS / 1 / 66 / 195 |
| PDF text one page | PASS / 1 / 4321 / 148 | PASS / 1 / 4321 / 148 |
| overlay detect | PASS / 1 / 252 / 107 | PASS / 1 / 252 / 108 |
| click Browse 1M+ applications | PASS / 1 / 574 / 428 | PASS / 1 / 109 / 450 |

0 FAIL. Search 2 steps is the cost of no `batch` on the card — leave it. Click char drop (545→86, 574→109) is the thinner musk receipt, not a FAIL.

Historical competitor board (`docs/pk-324-board.md`, measured 2026-08-17 on `22c525d4` vs Browser Use / Playwright) is **not** this comparison.

## Must-not-regress checklist

Code/docs evidence on the musk working tree, not vibes.

| Keep | Evidence | Status this tree |
|---|---|---|
| Live attach to the tab the user already has | `skills/chrome-cdp-ex/SKILL.md` (“connects to the browser they already have open”); README “The tab you already have”; default help “attach to the Chrome/Electron tab you already have”; `list`/`open`/`nav` still on the survivor card | kept |
| Per-tab daemon | `CLAUDE.md` architecture: per-tab daemon, Unix socket IPC, 20 min idle | kept (leftover modules not deleted) |
| Electron `CDP_PORT` not daily 9222 | SKILL example `CDP_PORT=9333 ./bin/chrome-cdp list`; `tests/hermes-electron-port.test.mjs` forbids `CDP_PORT=9222` in the skill Electron example | kept |
| Chrome 136 default-profile honesty | SKILL “From Chrome 136, the **default** profile cannot enable CDP”; README “Daily browser CDP (Chromium 136+)”; do not quit Dock/default to “fix” | kept |
| Zero runtime npm deps | `package.json` has no `"dependencies"` on both sides; only `devDependencies` (`eslint`, `vitest`, …). Runtime is Node 22 built-in WebSocket | kept |
| Secrets redacted by default | `skills/chrome-cdp-ex/scripts/cdp.mjs` `REDACTED_VALUE` / `redactSensitiveString`; command-surface still documents redacted checkpoints | kept |
| `click --js` is a FLAG | SKILL + default help. Not `jsclick` as a product name | kept |
| `eval --b64` is a FLAG | SKILL + default help. Not `eval64` as a product name | kept |

Leftover handlers remain in `cdp.mjs` / `command-surface.mjs` (81-command catalog still in the tree). `cdp help <command>` may still print leftover topic help. That is intentional: delete from the live card, not `rm` the module.

## Add-back log

Empty this run. Board 2 did not flip any row PASS→FAIL, so nothing was put back.

Empty may mean **under-deleted** (the 10% bar: delete more than we should; some items may later need a named-person put-back). Do not silently restore HuggingFace `/models?search=`, leftover-AX tautology, cap-swap sampling, hover-recapture law, or the 24-command remember list onto `SKILL.md`. Do not add `batch` back because search took 2 steps. If a later #324 row flips PASS→FAIL, named-person add-back goes on [#375](https://github.com/EndeavorYen/chrome-cdp-ex/issues/375).

Expected add-backs from the algorithm (not pre-kept, not applied here): thin MCP, PDF page-1 `text --auto` as SKILL law, overlay as click diagnosis, `@fN` refs, `click --js` already kept as a flag, `batch` if IPC hurts, `cascade` (already a survivor), doctor extra checks, JSON for MCP only.

## #375 children — implemented vs blocked (this checkout)

GitHub issues remain open. This is working-tree status, not merge/close status.

| # | Work | This checkout |
|---|---|---|
| #385 | SKILL.md is the 5-step golden path | **Implemented.** 4174-byte card; no `models?search`, `leftover-ax`, `cap-swap`. |
| #379 | Operator card names survivors only | **Implemented.** 20 Survivors; default help 21 rows; catalog still 81 in-tree. |
| #386 | Mutating commands print one-line evidence | **Implemented in unit tests** (nav/click/scroll skinny default). **Live Board 2 click/nav/scroll receipts recorded** (skinny click; search is fill+press). |
| #377 | README front door is live-session, not PK-324 | **Implemented.** First screen is attach → doctor/list → Chrome 136. No 10/8/9 SVG above the fold. |
| #376 | docs-contract must not freeze the 81-command card | **Implemented.** `SURVIVOR_COMMANDS` is the card; leftover names may leave SKILL without failing `check:docs`. Frozen `docs/contracts/v2.16.0` left in tree. |
| #383 | doctor stdout is Node / port / next command | **Mostly implemented** (123 chars). Next-command still `cdp doctor` when CDP is down. |
| #387 | MCP and six-host matrix are not live-path | **Implemented on the card.** SKILL/README Quick start do not mention stdio MCP, `confirm: true`, or `setup.mjs --for`. Adapter files remain. |
| #388 | Drop campaign/validation-lab as merge gates | **Implemented.** `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING.md` default gate is `npm test`, `lint`, `check:docs` (+ `smoke:live` when attach/perceive/act changes and a browser exists). |
| #384 | PK vs main `c332afc` at PR | **Board 1 and Board 2 recorded here.** Board 2 copied from #384 comments; not remeasured. |

## How to re-measure

Board 1 (no browser required):

```bash
git cat-file -s c332afca49296a55a16fc82008c98fc6506177f9:skills/chrome-cdp-ex/SKILL.md
node -e "const fs=require('fs'); const b=fs.readFileSync('skills/chrome-cdp-ex/SKILL.md'); console.log(b.length, b.toString('utf8').trim().split(/\s+/).length)"
node skills/chrome-cdp-ex/scripts/cdp.mjs help
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
```

Board 2 is already recorded above from #384 comments (Mini Edge 151, CDP 9222, 1042×632, n=3 median). Do not remeasure for this PR.
