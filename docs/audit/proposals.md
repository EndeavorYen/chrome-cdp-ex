# Proposals

The last audit phase: changes ranked by leverage, from the evidence in [findings.md](findings.md), [token-perf.md](token-perf.md), [scenarios.md](scenarios.md) and [haiku-probe.md](haiku-probe.md). Written on 2026-10-09 against `acd4312` (main after #626 and #613). The probe ran on `21e96b5`; neither of those two commits touches the code paths below.

Every proposal changes a default, a receipt or an error sentence. None adds a command.

## How the list is ranked

Leverage = S × T × R, each scored 1 to 3:

- **S, weak-model success.**
  - 3: following the default output or its Next leads to an irreversible wrong action, or to a false statement to the user.
  - 2: the task needs a workaround outside the golden path (`eval`, screenshots, guessing), or fails for a model that follows the output.
  - 1: the task succeeds at extra cost.
- **T, tokens and calls.**
  - 3: more than 10 extra calls or 10K extra chars in a Phase D run, or an MCP payload 10× the CLI's.
  - 2: 3 to 10 extra calls, or 2K to 10K extra chars.
  - 1: less, or not measured.
- **R, implementation risk (3 is safest).**
  - 3: one function or module, no change to a public contract, and no open PR on the same code.
  - 2: several call sites, receipt text that tests pin, or overlap with an open PR.
  - 1: cross-cutting (frames, targets, the MCP contract), or heavy overlap with open PRs.

Ties go to higher S, then to Phase D evidence, then to higher R.

## Already in flight

Six findings got open pull requests after the Phase B issues were filed. They are not proposed again. The Phase C and D evidence that bears on them:

| Finding | Open PR | What Phase C and D add |
|---|---|---|
| B-03, secrets printed by read commands (#634) | #646 | It breaks a non-negotiable, so it should merge whatever its rank. No probe run read `cookies` or `console`. |
| B-01, `press Enter` clicks a listing link (#632) | #647; #627 for #607 | In scenario 2 Haiku clicked Search instead of pressing Enter, so the probe never hit it. Scenario 2's trap path shows the failure. |
| B-11, `--since-action` renumbers refs (#642) | #650 (merged) | No probe run clicked a ref read from a since-action diff. |
| Covered click's Next is `click --js` (#601) | #624 | In scenario 3 the cover is a full-viewport backdrop beside the dialog, so #624 turns that Next from `click --js` into `overlay`. #624 keeps `dismiss-modal` as the Next for dialog covers; proposal 3 makes that Next safe to follow. |
| `perceive -C` length (#598, #599) | #628 | In scenarios 1, 4 and 8 Haiku finished `select` tasks with the CSS selectors from `[Visible controls]`, because `select @ref` fails (B-02). #628 keeps one `@ref selector` per row; that selector must stay. |
| netlog lost on daemon restart (#606) | #625 | It edits `lib/netlog.mjs`. Proposal 1 keeps its own change there to one branch. |

## Ranking

| # | Change | Findings | S | T | R | Leverage | Phase D evidence | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | A failed request is on the action receipt; an unread `no-store` body stays readable | T-07, B-15 | 3 | 2 | 2 | 12 | scenario 11 | merged (#654) |
| 2 | Directional `scroll` moves the scroller that `perceive` measures | B-09 | 2 | 2 | 3 | 12 | scenario 7 | merged (#655) |
| 3 | `dismiss-modal` never presses an accept button, and fails while the dialog stays | B-17 (#653), T-10 | 3 | 1 | 3 | 9 | live repro, scenario 3 | merged (#656) |
| 4 | One observation scope per action: frames, downloads, new tabs | B-07, B-08 | 3 | 3 | 1 | 9 | scenario 6 | proposal; #652 open (receipts phase) |
| 5 | `text` keeps field boundaries | B-16 | 2 | 1 | 3 | 6 | scenarios 7, 2 | merged (#659) |
| 6 | MCP returns the CLI receipt and lists the golden-path verbs | B-12 | 2 | 3 | 1 | 6 | none (Phase B) | proposal |
| 7 | Visual comparison names what changed | scenario 9 | 1 | 3 | 2 | 6 | scenario 9 | proposal |

Scoring notes:

- 1 and 2 tie at 12; 1 ranks first on S.
- 3 and 4 tie at 9 with equal S; 3 ranks first on R. Proposal 4 changes the input path that #627 is rewriting, and attaching to out-of-process frames is the largest change in this list.
- 5, 6 and 7 tie at 6. 5 and 6 rank above 7 on S; 5 ranks above 6 on Phase D evidence.

Why the scoring ranks 7 last although scenario 9 was the probe's largest token sink (37,106 chars, 25× the reference path): Haiku still finished the task, so S is 1.

Next lines in the probe: 9 of 18 were followed. Outside `doctor` → `list`, 2 of 12 were followed. The other ten were not runnable as given (`jsclick <t> x,y`), were harmful (`click --js` through a modal), or did not address the error (`help eval` after a page script threw, `perceive -C -d 8` after a flag error, `netlog` ↔ `netlog --id` in a loop). The brief counts an unfollowed hint as a design failure. Proposals 1 to 4 each replace one of those Next lines.

---

## 1. A failed request is on the action receipt; an unread `no-store` body stays readable

Findings: T-07, B-15 (#648). Code:

- `createActionDiagnosis` (`cdp.mjs:8462`): a network failure becomes `Next: cdp netlog <t>`.
- `formatDefaultMutatingActionText` (`cdp.mjs:9101`).
- `netlogRequestStr` (`cdp.mjs:21493`).

### Evidence

Scenario 11 (Haiku), 16 calls against the reference path's 7. Five of the calls read the network log, 3,357 chars in all:

```text
click <t> #save             → Clicked <BUTTON> "Save changes". Next: cdp netlog <t>          (exit 0)
netlog <t>                  → #1 POST …/api/profile → 503 (7ms, 0B)
netlog <t> --id 1           → 17 request headers, 7 response headers (1,283 chars)
help netlog
netlog <t> --id 1 --body    → Body: not available (still loading: No data found for resource with given identifier)
```

Haiku then told the user that "the response body was empty, the server gave no reason". The body was `{"error":"upstream timeout","retryAfterSeconds":2}`.

**B-15's cause, corrected.** Phase C blamed the tab daemon. A controlled 2 × 2 run on 2026-10-09 (`no-store` or not × the page reads the body or not; each request watched by a raw page WebSocket and by the daemon) shows that Chrome itself withholds the data:

| Response | Page reads the body | Raw page WebSocket | Tab daemon (`netlog`) |
|---|---|---|---|
| cacheable | no | `loadingFinished`, body readable | complete, body readable |
| `no-store` | no | no `loadingFinished`; `getResponseBody`: "No data found" | pending, 0B, "still loading" |
| cacheable | yes | `loadingFinished`, body readable | complete, body readable |
| `no-store` | yes | `loadingFinished`, body readable | complete, body readable |

Phase C's two experiments differed in two ways at once: the daemon run's page never read the body (`.then(r => r.status)`), the raw run's page did (`.then(r => r.text())`).

`Network.streamResourceContent({ requestId })` returns the bytes Chrome already received for the unread response (`bufferedData`: `{"error":"upstream timeout",…}`). A page that checks `r.ok` and throws without reading the body, as scenario 11's page does, is a common error path.

### Three questions

1. **Without this field, which task fails?** A network-failure task (type 11). Without the failed request on the receipt it takes three to five extra calls. Without the fallback the reason cannot be read at all, and the agent states a wrong one. The task fails; this is not a human shortcut.
2. **Why is the model deciding?** It need not be. When the receipt is built, the daemon already knows which requests the action sent, their status, their `Retry-After`, and where to get the body. Today the model has to decide to open `netlog`, pick an id and ask for `--body`.
3. **Can a weak model pick the next command from the default receipt?** Not today. `Clicked … Next: cdp netlog` hides that the save failed. With the change, the receipt names the failed request, its status, `Retry-After` and a body excerpt, so "wait and retry once" or "tell the user" follows from it. No command is added.

### Change

- **At receipt time,** for each failed request in the action's network delta (status ≥ 400 or `loadingFailed`; at most two), the daemon attaches:
  - the status text and `Retry-After`;
  - a body excerpt of at most 200 chars, redacted the same way as `netlog --body`. It comes from `Network.getResponseBody`, falling back to `Network.streamResourceContent`.
- **The default receipt** gets one line per failed request, `Request failed: POST /api/profile → 503 Service Unavailable; Retry-After: 2; body: {"error":"upstream timeout",…}`.
  - With an excerpt, Next is `perceive <t> --since-action`, to see how the page reported it.
  - Without one, Next is `netlog <t> --id N --body`.
- **`netlog --id N --body`** uses the same fallback. A response the page never read is labelled as such; it no longer says "still loading".

### The case for leaving it

`netlog` exists and the Next line already points at it. Bodies in receipts add bytes and may carry personal data.

The answer: only failed requests get an excerpt. It is capped at 200 chars and redacted by the same rules as `netlog --body`, which the agent would otherwise call anyway. Successful receipts do not change.

### Cost

| | Now (scenario 11) | After (measured) |
|---|---|---|
| Reference path | 7 calls, 1,771 chars (`netlog` + `netlog --id --body`) | 5 calls, 516 chars; the reason comes from the click receipt |
| Haiku | 16 calls, 7,855 chars, 5 of them `netlog`; a false reason told to the user | 13 calls, 6,136 chars, no `netlog`; the user is told "503, upstream timeout, Retry-After 2" |

### Contract files

- `skills/chrome-cdp-ex/scripts/cdp.mjs`: daemon enrichment, the default receipt, `netlogRequestStr`.
- `skills/chrome-cdp-ex/scripts/lib/netlog.mjs`: the label for an unread body.
- `docs/contracts/v2.21.0/runtime-dispatch.v1.json` (line numbers).
- `skills/chrome-cdp-ex/references/commands.md` (netlog).
- The action JSON `effects.networkDelta.entries[]` gains optional `statusText`, `retryAfter` and `body`. This is additive.

### Rollback

Revert the commit. The enrichment is one function called from `enrichActionResult`. The fallback is one branch in `netlogRequestStr`.

### Tests

- Unit tests:
  - fallback order (a `getResponseBody` error, then `bufferedData`);
  - the receipt line for 4xx and 5xx with and without a body;
  - the 200-char cap and redaction;
  - Next with and without an excerpt.
- Live: scenario 11's reference path without `netlog` calls, the self-test with its trap, and one Haiku run.

---

## 2. Directional `scroll` moves the scroller that `perceive` measures

Finding: B-09 (#640). Code:

- `scrollStr` (`cdp.mjs:18568`), whose guard sits at `cdp.mjs:18585`.
- `scroll` argument split (`cdp.mjs:28824`).
- `scrollEdgeLogicSource` (`cdp.mjs:18393`) already finds nested scrollers for `to top|bottom`.

### Evidence

Scenario 7 (Haiku):

```text
help scroll
scroll <t> down 6400 --scroll-container #viewport  → Error: scroll: --scroll-container is only valid with to top/to bottom   Kind: unknown
                                                     Next: cdp perceive <t> -C -d 8   (exit 1)
scroll <t> down 6400                               → Scrolled by (0, 6400). Position: (0, 0)   (exit 0; nothing moved)
text <t> --auto                                    → the same first rows
help eval
eval <t> "…querySelector('#viewport').scrollTop = 6488 …"
```

These are six of its 13 calls, 2,271 chars. The reference path had to use `eval` too; no CLI form scrolls `#viewport` by an amount. In Phase B, `scroll <t> down --scroll-container "#main"` exited 0 and moved nothing: the flag was read as the amount.

### Three questions

1. **Without it, which task fails?** Paging a list or table in an app shell (type 7). Admin tables, mail and chat logs scroll inside a container. The task needs `eval` or fails. `to bottom` jumps past the row.
2. **Why is the model deciding?** Which element scrolls is already decided by the tool: `perceive` reports `Scroll: 0/6147` for the nested scroller, and `to top|bottom` finds it. The model should not have to name it with `--scroll-container`.
3. **Can a weak model pick the next command from the default receipt?** Not today. "Scrolled by (0, 6400)" says success; only `Position: (0, 0)` hints otherwise. With the change, the receipt names the container and its position before and after, or says that nothing moved.

### Change

- `scroll <t> down|up|left|right [N] [--scroll-container SEL]` moves:
  - the container given with `--scroll-container`, now accepted with any direction and amount;
  - otherwise the document, when it can scroll on that axis;
  - otherwise the primary scroll container (the same one `to bottom` and `perceive` use).
- The receipt is `Scrolled <container> by (0, 500): scrollTop 0 → 500 / 17,600 max`.
- At an edge it says `already at bottom`. When nothing on the page can scroll, it exits 1 with `Kind: not-scrollable`.

### The case for leaving it

Directional scroll has always meant the window. On a page with several scrollers the tool could pick the wrong one.

The answer: the document still comes first when it can scroll. The fallback is the container `perceive` already reports, and the receipt names the container it moved.

### Cost

| | Now (scenario 7) | After (measured) |
|---|---|---|
| Reference path | 4 calls, 2,784 chars, one of them `eval` | 3 calls, 1,424 chars, no `eval` |
| Haiku | 13 calls, 7,231 chars; one refused and one no-op scroll, then `eval` set `scrollTop` | 12 calls, 6,332 chars; its first scroll moved `#viewport` |

### Contract files

- `cdp.mjs` (`scrollStr` and the `scroll` argument split).
- `references/commands.md` and the `scroll` help line.
- `runtime-dispatch.v1.json` (line numbers).
- Tests that pin `Scrolled by (…). Position: (…)`.

### Rollback

Revert the commit. Only `scrollStr` and its argument split change.

### Tests

- Unit tests:
  - argument parsing (`down`, `down 300`, `down --scroll-container SEL`, `down 300 --scroll-container SEL`);
  - the document-first rule;
  - the fallback to the nested scroller;
  - at-edge and not-scrollable receipts.
- Live: scenario 7's reference path with `scroll` instead of `eval`, the self-test with its trap, and one Haiku run.

---

## 3. `dismiss-modal` never presses an accept button, and fails while the dialog stays

Findings: B-17 (new, below), T-10. Code:

- `dismissModalScript` and `dismissModalStr` (`cdp.mjs:27642`, `cdp.mjs:27704`).
- `dismiss-modal` is the Next of:
  - a click covered by a dialog (`action-recovery.mjs:292`);
  - an overlay failure (`action-recovery.mjs:565`);
  - the `overlay` command (`cdp.mjs:27587`, `cdp.mjs:27629`).

### Evidence

**B-17, reproduced live on 2026-10-09.** The page is a "Delete project?" dialog (`role=dialog`, `aria-modal`) whose first button deletes:

```text
[OK, delete it] [Cancel]   dismiss-modal <t> → Dismissed modal via close button "ok" (div)   (exit 0)   server: POST /delete received
[確認] [取消]               dismiss-modal <t> → Dismissed modal via close button "確認" (div) (exit 0)   server: POST /delete received
```

The script takes the first visible control in DOM order whose text or aria-label contains any of `close`, `dismiss`, `cancel`, `ok`, `關閉`, `取消`, `確認`, `繼續`, `×`, `✕`. So it presses "OK" and "確認" (confirm), and any label containing the letters "ok", such as "Book now".

**T-10.** Scenario 3's session dialog (Stay signed in, Sign out) has no close control. `dismiss-modal` sends Escape, the dialog stays, and the command exits 0 with `Outcome: no-change`.

### Three questions

1. **Without the accept labels, which task fails?** None. Closing a dialog never requires accepting it. Accepting is an intent that the model states by clicking that button. What goes away is a shortcut: one call to clear a notice whose only button is "OK".
2. **Why is the model deciding?** Which control closes a dialog without consequences can be decided by the program when there is an explicit close or cancel control. Choosing between "Stay signed in" and "Sign out", or "OK, delete it" and "Cancel", is the user's intent, so the model must make that choice and the tool must not guess it.
3. **Can a weak model pick the next command from the default receipt?** Not today. "Dismissed modal" with exit 0 hides a deletion; "sent Escape as fallback" with exit 0 hides a dialog that is still open. With the change, exit 0 means the dialog is gone. Otherwise the command exits 1 and lists the dialog's buttons, so the model picks one by intent.

### Change

- `dismiss-modal` clicks only explicit dismiss controls:
  - `aria-label` or `title` naming close, dismiss or cancel (關閉, 取消);
  - text that is exactly ×, ✕, Close, Cancel, Dismiss, 關閉 or 取消;
  - `[data-dismiss]` or `[data-close]`.
- Matching is on whole words. Accept words (`ok`, `確認`, `繼續`) are never matched.
- With no such control it sends Escape and checks again. A dialog that is still visible makes it exit 1 with `Kind: dialog-open`, the dialog's name and its buttons. That error has no Next that clicks anything.

### The case for leaving it

"OK" closes many harmless notices in one call.

The answer: the same rule confirms destructive dialogs, and three recovery paths (covered click, overlay failure, the `overlay` command) send agents to `dismiss-modal`. A notice with only "OK" now costs one more call.

### Cost

| | Now | After (measured live) |
|---|---|---|
| Destructive confirm dialog | exit 0, "Dismissed", the project deleted | Cancel / 取消 pressed, nothing deleted |
| Scenario 3's session dialog | exit 0, `Outcome: no-change`, dialog open | exit 1, `Kind: dialog-open`, the dialog and both buttons named, nobody signed out |

### Contract files

- `cdp.mjs` (`dismissModalScript`, `dismissModalStr`).
- `references/commands.md` (dismiss-modal).
- `runtime-dispatch.v1.json` (line numbers).
- The `dismissModalStr` tests in `tests/cdp.test.mjs`.

### Rollback

Revert the commit. Only the two functions change.

### Tests

- Unit tests run the page script on a fake DOM, as the existing #276 test does:
  - `[OK, delete it][Cancel]` clicks Cancel;
  - `[確認][取消]` clicks 取消;
  - "Book now" with an × button clicks ×;
  - `[Stay signed in][Sign out]` finds no control;
  - after Escape, a dialog that is still open raises `dialog-open` with both button names.
- Live: the repro page (no `POST /delete`), and scenario 3's self-test.

---

## 4. One observation scope per action: frames, downloads, new tabs

Findings: B-07 (#638), B-08 (#639).

### Evidence

Scenario 6 (Haiku) took 30 calls against the reference path's 8, including 6 screenshots and 9 `help` calls.

- `clickxy` into the cross-site payment frame reported `Kind: no-input-events` (exit 1) although the click landed.
- `type` into the focused frame reported `Outcome: no-change … Verdict: investigate`.
- `perceive` shows no iframe node, and `frame` lists no cross-site frame.

**Correction to B-08(a).** Its Next, `jsclick <t> 141,81`, does not click a second time. `jsclick` takes no coordinates, so it fails with `Named control not found: "141,81"` (`Kind: selector`), checked live on 2026-10-09. The double payment comes from a model that retries the click reported as failed: in that check the first `clickxy` had already registered one payment.

B-08(b) and (c) stand:

- A download link exits 1 with `no-navigation` while the file lands in the user's Downloads folder, and Next `jsclick "#dl"` downloads it again.
- `window.open` is reported as `click-no-change` while the new tab is there.

### Three questions

1. **Without it, which task fails?**
   - Payment, SSO and embedded-editor tasks (type 6).
   - Downloads without `--expect-download` (type 8).
   - Popups.

   Each fails, or is reported as failed after it happened.
2. **Why is the model deciding?** The tool can see whether input reached a child frame, a download began, or a tab opened (`Target.setAutoAttach`, `Browser.downloadWillBegin`, `Target.targetCreated` with an opener). The model cannot; it takes screenshots to find out.
3. **Can a weak model pick the next command from the default receipt?** Not today: the receipt says "failed" for an action that happened. With the change it reports the effect.

### Change, in phases

1. **Receipts only.**
   - When the hit test lands on an `<iframe>`, report the input as delivered to that frame (unverified) and give no repeat Next.
   - Report downloads and new targets that start during the action window as effects.
2. **Perception.**
   - `perceive` lists iframes with frame refs and same- or cross-site.
   - The daemon auto-attaches out-of-process frames, so `frame` and `perceive --frame` reach them.

### The case for leaving it

Phase 2 changes how the daemon plumbs sessions: input routing, and refs per session. #627 is rewriting the same input-verification path. That is why R is 1 and this proposal waits for #627.

### Cost

| | Now | After (expected, not measured) |
|---|---|---|
| Scenario 6 | Haiku 30 calls, 9,301 chars; reference path 8 calls using fixed frame offsets | about the reference path, plus one verification screenshot |
| B-08 download | exit 1, the file in the user's Downloads, Next downloads it again | exit 0, "Started download report.csv" |

### Contract files

- Click, `clickxy` and `type` receipts.
- The `perceive` tree and `frame` output.
- The MCP mapping.
- `references/commands.md`.

### Rollback

Per phase. Phase 1 is confined to the action verifier.

### Tests

- Scenario 6's self-test with its trap.
- Receipt tests for an iframe point, a download and `window.open`, on the Phase B fixtures (`/iframe-host.html`, `/download.html`).

---

## 5. `text` keeps field boundaries

Finding: B-16 (#649). Code: `textPageScript` (`cdp.mjs:22340`).

### Evidence

- **Scenario 7:** Haiku's last call was an `eval` to split one row into cells, because `text --auto` gave `SHP-00183AdatumIn transit2026-10-14`.
- **Scenario 2:** the detail panel reads `Part numberBP-4471-CPrice$64.90In stock37`.

### Three questions

1. **Without it, which task fails?** Reading a field from a table, a detail panel or a grid. That is the last step of most tasks, and today it needs `eval` or guessing.
2. **Why is the model deciding?** Cell boundaries are in the computed `display` (`table-cell`, grid and flex items, `dt`/`dd`). The walker can emit them.
3. **Can a weak model pick the next command from the default receipt?** Mostly yes, but values run into labels. With the change, a tab separates cells, and a newline separates rows and `dt`/`dd` pairs.

### Change

`textPageScript` emits a tab after table cells and grid or flex items, and a newline after rows, `dt` and `dd`.

### The case for leaving it

`text` output grows by a few characters per row, and fixtures that pin `text` output change.

### Cost

One `eval` per field read today; zero after (expected).

### Contract files

- `text` output, which has no schema.
- `references/commands.md`.

### Rollback

Revert `textPageScript`.

### Tests

- The B-16 fixtures (table, `dl`, CSS grid).
- Scenarios 2 and 7, with their reference paths reading fields from `text`.

---

## 6. MCP returns the CLI receipt and lists the golden-path verbs

Finding: B-12 (#643).

### Evidence

From Phase B (`docs/audit/mcp-probe.mjs`); the probe did not run MCP.

- **A refused click:**
  - is 15,761 B: a pretty-printed JSON receipt as text (8,277 chars) plus `structuredContent` (6,454 chars);
  - the CLI prints 313 chars for the same failure;
  - its next steps are CLI strings.
- **`run_command`** refuses `status`, `jsclick`, `eval`, `overlay` and `netlog`, which Next lines name.
- **`report`** answers although `tools/list` does not list it.
- **`tools/list`** is 10,999 B for 14 tools.

### Three questions

1. **Without the JSON text block, which task fails?** None: `structuredContent` carries the same data. What fails today is recovery, because an MCP agent cannot run the Next it is given.
2. **Why is the model deciding?** Which recovery commands are allowed is the tool's own policy. A Next must be callable.
3. **Can a weak model pick the next command from the default receipt?** Not over MCP: the Next is a CLI string that `run_command` refuses.

### Change

- A tool result is the CLI text receipt plus a small `structuredContent` (`kind`, `outcome`, `next` as a tool call).
- `run_command` accepts every command a Next can name.
- `tools/list` lists the golden-path verbs, and unlisted tools are refused.

### The case for leaving it

MCP clients may parse the JSON text, and the change touches the contract of all 14 tools. #646 and #647 edit `mcp-adapter.mjs` and `command-surface.mjs` right now.

### Cost

| | Now | After (expected) |
|---|---|---|
| A refused click | 15,761 B | about 313 chars plus a structured block under 500 B |
| `tools/list` | 10,999 B | shrinks with the tool count |

### Contract files

- `scripts/lib/mcp-adapter.mjs` and `scripts/lib/command-surface.mjs`.
- The MCP contract tests.
- `docs/contracts`.

### Rollback

Revert the commit. Its MCP contract version is the rollback point.

### Tests

- `mcp-probe.mjs` before and after.
- The MCP contract tests.
- Scenario 3 through MCP: a covered click, then the Next called as a tool.

---

## 7. Visual comparison names what changed

Evidence comes from scenario 9. Code:

- `diffShotCompareScript` (`cdp.mjs:6145`).
- `formatDiffShotResult` (`cdp.mjs:6222`).

### Evidence

Haiku took 16 calls and 37,106 chars, against the reference path's 5 calls and 1,483 chars. Three `eval` calls of about 10,000 chars each hashed computed styles before and after the click.

`diff-shot` exists, but neither SKILL.md nor the help card names it. Its compare receipt gives a changed-pixel ratio, three PNG paths, and "Pixel diff only".

### Three questions

1. **Without it, which task fails?** A visual comparison (type 9) gets done with style dumps through `eval` (25× the chars) or with `scanshot`, which the scenario forbids.
2. **Why is the model deciding?** Which regions changed, and which element each belongs to, can be computed in the compare step, where the diff is already computed in the page.
3. **Can a weak model pick the next command from the default receipt?** Not today: "changed 1.8%" plus paths means opening the image. With the change, the receipt names the changed elements.

### Change

- `diff-shot` compare groups changed pixels into at most 5 boxes and names the element at each one, for example `Changed: <SECTION#w-revenue> "Revenue" (24,180 300×120)`.
- SKILL.md's step 5 gets one rule: for a visual change between two states, run `diff-shot` before and after.

### The case for leaving it

It puts one more command on the SKILL menu, which the brief treats as a tax by default. Scenario 9 is the evidence the brief asks for. An alternative is to fold `diff-shot` into `shot --diff`.

### Cost

| | Now | After (expected) |
|---|---|---|
| Scenario 9 | Haiku 16 calls, 37,106 chars | about 5 calls, under 2,000 chars |

### Contract files

- `diff-shot` text and JSON (additive: `regions[]`).
- SKILL.md; the docs contract, which counts survivor commands.
- `references/commands.md`.

### Rollback

Revert the commit. The SKILL line is separate.

### Tests

- A compare on a fixture with two changed cards.
- Scenario 9's reference path reads the regions from text instead of decoding the PNG.

---

## Appendix: 8 and later (not done by default)

| # | Change | Findings | Evidence | Why not in 1 to 7 |
|---|---|---|---|---|
| 8 | Golden-path overhead | A-10, B-04 (#635) | Doctor ran first in 6 of 12 runs (1.4–2.1 s each); 37 `help` calls (18,081 chars, 15 % of all chars); `help stop` 5×, `help eval` 6×; `click --help` lacks `--expect-download` (scenario 8) | S 1, T 2, R 2 = 4. The fix: SKILL.md step 1 becomes `list` only, and doctor runs when attach fails. SKILL lines carry the exact `stop <t>` / `eval` syntax. Every help text lists the flags SKILL.md teaches. B-04's attach guidance converges on the inspect toggle, which keeps the logged-in session. Four open PRs edit SKILL.md now. |
| 9 | A source-mapped console frame prints its source line | scenario 10 | Haiku fetched and decoded the source map with 4 `eval` calls (about 3,000 chars), partly to quote the line | S 1, T 1 to 2, R 3. The calls also served the "why" in the answer, so the saving is uncertain. |
| 10 | Next lines that run when copied; one Kind classifier | B-05 (#636), B-06 (#637) | Haiku re-typed every command and never pasted a Next verbatim, so the measured cost of the `(Kind: …)` suffix is 0 calls. The cost is in Next content: proposals 1–4. | S 2, T 1, R 1: #624, #627 and #628 pin the suffix in new tests. |
| 11 | `open` waits 1.5 s for nothing | B-13 (#644) | 2.2 s per `open` | Time only; no probe run used `open`. |
| 12 | One `shot` command with flags (`shot`, `scanshot`, `elshot`, `diff-shot`) | brief, A | Scenario 12 used `elshot` correctly; no run hesitated between them | No measured failure. |
| 13 | Others | T-01, T-02, T-03, T-04, T-05, T-09, T-11, B-14 (#645) | findings.md | Each is THIN or a test fix with no probe cost. T-04 (dialogs auto-accepted) is related to proposal 3; it concerns native `confirm()`. |

## Results of 1 to 3

Implemented on `acd4312`, then split into three pull requests on `63f452f` (main after #650). All three were merged on 2026-10-09, each after a rebase, a full local gate and green CI:

| # | PR | Fixes | Merged as |
|---|---|---|---|
| 1 | #654 | #648, and T-07 | `45bcdca` |
| 2 | #655 | #640 | `bb89670` |
| 3 | #656 | #653, filed for B-17, and T-10 | `0e636ff` |

Proposal 5 followed as #659 (Fixes #649), merged as `895f245`.

Each PR reports its own gates and its before/after `agentChars` and `wallMs` on the affected path. The numbers below are from the combined build on `acd4312`.

### Gates

- `npm test -- --maxWorkers=2` (the CI setting): 191 files, 3,986 passed, 86 skipped.
  - The default worker count timed out 2 to 13 tests per run on this host while other sessions loaded it. Each of those tests passed on its own.
- `npm run lint`: 0 errors. The one warning is in `tests/cdp.test.mjs`, a file this change does not touch.
- `npm run check:docs` and `npm run check:contracts`: OK.
- `npm run smoke:live`: 108 checks passed, headless on port 9471. Port 9333, the default, was held by another process's Chrome.
- All 12 scenario self-tests passed, and each trap path failed as expected.

### New tests

- `tests/issue-648-failed-request-receipt.test.mjs` (11 tests).
- `tests/issue-640-directional-scroll.test.mjs` (8 tests).
- `tests/dismiss-modal-close-only.test.mjs` (9 tests).
- Updated pins:
  - `tests/scroll-to-edge.test.mjs`, which asserted B-09's behaviour;
  - the CDP inventory in `tests/cdp-domain-characterization.test.mjs` and `tests/cdp-domains.test.mjs`;
  - `docs/contracts/v2.21.0/runtime-dispatch.v1.json`, line numbers only.

### Reference paths

Same harness, same base, before and after:

| Scenario | Before | After | What changed |
|---|---|---|---|
| 11 network failure | 7 calls, 1,771 chars | 5 calls, 516 chars | The click receipt carries `Request failed: … 503 …; Retry-After: 2; body: {"error":"upstream timeout",…}`; no `netlog` calls |
| 7 virtual list | 4 calls, 2,784 chars | 3 calls, 1,424 chars | `scroll <t> down 6388` moves `#viewport`; no `eval` |
| 4 validation | 10 calls, 1,899 chars | 10 calls, 2,090 chars | The 422 receipt now names the error ("Tax ID must be exactly 8 digits…"): +191 chars. The path itself was not shortened. |

### Haiku 5.5

One run per scenario, the same v2 prompt and SKILL.md as Phase D, so the CLI is the only change. The same temporary `cdp.mjs` guard was in place; the code was restored byte for byte afterwards (sha256 checked). Guard hits during the agent runs: 0. Data: [haiku-probe-after.json](haiku-probe-after.json).

| Scenario | Result | Calls | Chars | Failed calls | `help` | `netlog` | Model s | Agent tokens |
|---|---|---|---|---|---|---|---|---|
| 4 | pass → pass | 17 → 12 | 6,590 → 4,280 | 0 → 0 | 3 → 0 | 0 → 0 | 35.6 → 25.5 | 57,026 → 55,431 |
| 7 | pass → pass | 13 → 12 | 7,231 → 6,332 | 1 → 0 | 4 → 3 | 0 → 0 | 67.5 → 41.2 | 64,890 → 57,913 |
| 11 | pass → pass | 16 → 13 | 7,855 → 6,136 | 1 → 0 | 2 → 2 | 5 → 0 | 34.2 → 43.5 | 57,976 → 59,549 |
| Total | | 46 → 37 (−20 %) | 21,676 → 16,748 (−23 %) | 2 → 0 | 9 → 5 | 5 → 0 | | |

What the runs show:

- **Scenario 11.** The false statement is gone. Before, Haiku said the body was empty; now its answer gives the 503, "upstream timeout" and Retry-After 2, all read from the click receipt. It did not open `netlog` at all.
- **Scenario 4.** After the 422 receipt Haiku fixed the tax ID directly. Before, it ran `perceive -C -d 8` (1,883 chars) to find the error.
- **Scenario 7.**
  - `scroll … down 6400 --scroll-container #viewport` worked on the first try. Before, the same call was refused, and the next one moved nothing.
  - Haiku still read rows with `eval`.
  - The saving here is small. Before this change the CLI could not do the task at all, and that is the larger result.

Noise: n = 1 per arm. The only Phase D pair run under identical conditions (scenario 1, smoke run against official run) differed by 2 calls (13 against 15).

- Scenario 4's change (−5 calls) is larger than that; 7's (−1) is not, and 11's (−3) is borderline.
- The qualitative changes do not depend on run-to-run variance: the false reason, the refused and no-op scrolls, and the five `netlog` calls are gone.
- Separating a 20 % change in calls from noise would take at least 5 runs per arm per scenario.

**Proposal 3** has no model run: none of the 12 scenarios routes an agent into `dismiss-modal` under the current receipts. Its evidence is the live repro on the "Delete project?" pages and the session-dialog page:

- before, 2 deletions;
- after, 0 deletions, 0 sign-outs, and `Kind: dialog-open` with both button names.

## Results of 7

Implemented on `19af5ce` for #661. The compare receipt names the element behind each changed region, and SKILL.md gets the one paragraph.

### Reference path

Scenario 9 reads the changed cards from the region lines: 4 calls, 1,469 chars. Before, it decoded the diff PNG and read the card boxes with `eval`: 5 calls, 1,483 chars.

### Haiku 5.5

One run, the same v2 prompt as Phase D, with this branch's SKILL.md: the CLI and SKILL.md both changed. The same temporary guard was in place; `cdp.mjs` was restored byte for byte afterwards (sha256 checked). Data: [haiku-probe-after-7.json](haiku-probe-after-7.json).

| Scenario | Result | Calls | Chars | Failed calls | `help` | `eval` | Agent tool uses |
|---|---|---|---|---|---|---|---|
| 9 | pass → pass | 16 → 8 | 37,106 → 4,435 | 0 → 0 | 3 → 1 | 3 → 0 | 17 → 10 |

- Haiku ran `diff-shot` before and after the click and answered from its region lines. It named Revenue and Churn, and said the pressed button changed too but is not a widget.
- It then wrote a small node script to compare the two PNGs pixel by pixel, and ran a second compare to check that nothing was still moving. Those are 2 of its 10 tool uses and 1 of its 8 calls.
- Noise: n = 1. A drop from 16 to 8 calls is four times the 2-call spread of the one identical Phase D pair. The drop in chars comes from the 3 `eval` dumps that are gone.
