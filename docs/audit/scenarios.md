# Phase C: agent scenarios

Twelve executable scenarios for the Phase D probe (Haiku 5.5) and for later regression runs. Audit of chrome-cdp-ex 2.21.0 at `21e96b5`, 2026-10-09. Phase B's findings are in [findings.md](findings.md).

- Each scenario is one module in `validation/scenarios/NN-*.mjs`: its spec (user words, start state, allowed oracle, forbidden shortcuts, success condition, failure taxonomy, weak-model traps, reference path), the app it runs against, a reference path, a trap path, and a judge. The shared harness is `scripts/lib/agent-scenario-harness.mjs`.
- `validation/scenarios/registry.v1.json` registers all twelve with the existing `validation/schemas/scenario.v1.json` schema, so `scripts/validation-lab.mjs` runs them. It is a separate registry: the canonical `validation/scenarios.v1.json` and its pinned test stay as they are.
- The validation lab allows only loopback servers and a disposable local browser. As decided on 2026-10-09, the "at most half localhost static pages" rule is met with local dynamic apps: 9 scenarios run against apps with server state (server-side sessions and CSRF, a two-site checkout whose card form is an out-of-process iframe, a paged API, server-side validation, payment and approval records), and 3 are static pages (visual diff, source map, WebGL).
- `tests/agent-scenarios-contract.test.mjs` checks the registry, every spec, the type coverage, the static-page limit, and that this document carries each scenario's user words.

## Running

| Command | What it does |
|---|---|
| `node validation/scenarios/<file>.mjs --self-test [--verbose] [--timeline]` | Starts a disposable headless browser and the scenario's loopback servers, runs the reference path and judges it, then runs the trap path in a fresh browser and requires the judge to fail it with the expected codes. Exit 0 only if both hold. |
| `node scripts/validation-lab.mjs run --registry validation/scenarios/registry.v1.json --out-dir <dir> --allow-live --scenario <id> …` | The same through the validation lab, with evidence bundles. The lab budget allows five scenarios per run. |
| `node validation/scenarios/<file>.mjs --prepare` | For agent probes: sets the start state and prints a JSON handoff (user words, `CDP_PORT` and runtime-dir env, CLI path, judge and teardown URLs). After the agent finishes, POST `{"answer": …, "transcript": [{"args": […], "stdout": …, "stderr": …}]}` to the judge URL, then POST to the teardown URL. |
| `node validation/scenarios/<file>.mjs --print-spec` | Prints the spec as JSON; no browser. |

Browser: `CDP_SCENARIO_BROWSER=<path>`, else Chrome for Testing from the Playwright cache, else the installed Chrome or Edge, always with a throwaway profile on a free port. The profile's download folder is a temp directory, never the user's Downloads (checked: the user's Downloads folder was unchanged after every run).

## How a run is judged

- **App state** the agent cannot fake: settings, sessions, decisions, vendors, flags, payments, exports and API calls recorded by the scenario's own servers.
- **Browser state** read over a separate raw CDP connection (not through cdp.mjs), after the app servers have been quiet for 750 ms.
- **Page instrumentation** where the shortcut is invisible to the server: whether the approval click was trusted and the modal was open (3); whether the payment widget was loaded inside the checkout or as its own page, from `Sec-Fetch-Dest` (6); the app's client header on API calls, which a curl or `eval fetch` call lacks (direct-API detection).
- **Transcript**: no secret value (session cookies) may appear in any output the agent read; some commands are forbidden in some scenarios (`scanshot`/`fullshot` in 9, `inject` and handler-patching `eval` in 10).
- **Answer**: the specific values the user asked for (part number, stock, ETA, total, node, file and line), and claims of success checked against the app state (`false-success`), plus the reverse in 6 and 11 (`false-failure`).
- **Negative control**: every scenario has a trap path, usually the weak-model trap itself, and the self-test requires the judge to fail it with the listed codes.

## Summary

Reference-path costs are from the validation-lab run (Chrome 154 headless, Windows 11); chars are what the reference path read (stdout + stderr).

| # | Scenario | Kind | Reference path | Trap path → judge | Main traps |
|---|---|---|---|---|---|
| 1 | `agent-01-admin-session-setting` | dynamic | 6 calls, 3,369 chars, 4.0 s | not-saved, ui-not-updated, false-success, secret-leak | #633 select @ref, #641, #634 cookies |
| 2 | `agent-02-spa-search-detail` | dynamic | 6 calls, 1,853 chars, 4.6 s | wrong-item, missing-fields, left-app | #632 press Enter, #642, #641, #649 |
| 3 | `agent-03-modal-blocks-approve` | dynamic | 6 calls, 4,444 chars, 4.5 s | click-through-modal | #601 `--js` Next, dismiss-modal exit 0 |
| 4 | `agent-04-form-validation-resubmit` | dynamic | 10 calls, 1,899 chars, 6.7 s | not-created, false-success | T-08 since-action text, #641 |
| 5 | `agent-05-multi-tab-wrong-tab` | dynamic | 4 calls, 2,064 chars, 5.7 s | production-changed, not-changed, false-success | identical titles, `*` tie-break |
| 6 | `agent-06-cross-origin-iframe-pay` | dynamic | 8 calls, 2,606 chars, 5.3 s | duplicate-payment, false-failure | #638 iframe invisible, #639 false no-input-events |
| 7 | `agent-07-virtual-list-find` | dynamic | 4 calls, 2,786 chars, 2.9 s | not-found, not-rendered | #640 scroll no-op success, T-02, #649 |
| 8 | `agent-08-export-download-session` | dynamic | 3 calls, 561 chars, 4.3 s | no-file, wrong-total, duplicate-download, stray-download | #639 download "did not navigate", #634 |
| 9 | `agent-09-visual-diff-widgets` | static | 5 calls, 1,483 chars, 3.3 s | wrong-widgets, full-page-capture | AX-identical change, baseline order |
| 10 | `agent-10-console-sourcemap` | static | 3 calls, 369 chars, 3.4 s | wrong-location | async error, lazy source maps |
| 11 | `agent-11-network-failure-retry` | dynamic | 7 calls, 1,770 chars, 6.8 s | false-success, retry-storm, no-reason | #648 no-store body, T-07 |
| 12 | `agent-12-webgl-canvas-read` | static | 2 calls, 279 chars, 2.4 s | wrong-node | canvas-only content, image path |

The reference paths are the oracle for Phase D: a probe run is compared with them in calls, chars and time, and judged by the same code.

## Harness notes

Three things looked like product failures while the harness was built. All three were harness faults; none is reported as a finding.

- **A blocked event loop stalled a navigation.** The first harness ran CLI calls with `spawnSync` while it held an open CDP WebSocket to the browser. A form POST after `click` then reached the server 36 s late, and the click and the next `text` timed out. With asynchronous spawns the same click returns in 0.45 s and the POST arrives 0.2 s after it. Chrome appears to wait for a client that does not read its socket; whether a busy tab daemon can cause the same stall (compare #619) was not checked.
- **A wait that treated errors as "ready"**: a setup returned before the page had loaded, so the first `perceive` legitimately missed a modal that was not on the page yet.
- **Unsafe ports**: this host hands out ports such as 6667 from its dynamic range; Node's `fetch` and Chrome refuse the Fetch standard's unsafe ports, so the harness skips them.

## Corrections made during Phase D

The Haiku runs exposed three faults in the scenarios themselves. Each was fixed, the self-test (reference and trap) re-run, and the affected probe result handled as stated in [haiku-probe.md](haiku-probe.md):

- **Scenario 10 judge**: the `edit-page-code` check matched any `eval` containing `r =`, so a read-only `eval` that named a variable `r` counted as patching the page. It now counts only `inject`, added handlers, and rewritten globals or prototypes. The Haiku answer was re-judged with the corrected rule.
- **Scenario 11 fixture**: `/profile` always rendered the initial name, so a reload after a successful save showed the old value. It now renders the stored name, and the judge gained `false-failure`. The Haiku run against the faulty page is void and was re-run.
- **Scenario 12 judge**: the spec says no other node may be named as the hottest; the judge failed any answer that also ranked other nodes. It now requires the first node named to be N-07. The Haiku answer was re-judged.

## After proposals 1 to 3

Proposals 1 to 3 ([proposals.md](proposals.md)) changed the CLI under three scenarios.

Specs and reference paths changed in two of them:

- **Scenario 7.**
  - The reference path scrolls `#viewport` with `scroll <t> down 6388` instead of `eval`: 3 calls, 1,424 chars (was 4 calls, 2,784 chars).
  - The B-09 trap moved to a "before proposal 2" note.
  - The trap path still fails as expected, because three default scrolls stop near row 40.
- **Scenario 11.**
  - The reference path reads the reason from the click receipt's `Request failed:` line instead of `netlog`: 5 calls, 516 chars (was 7 calls, 1,771 chars).
  - The oracle now names the receipt.

Scenario 4 was not edited. Its 422 receipt now carries the server's error, which adds 191 chars: 10 calls, 2,090 chars.

Proposal 5 (#659) changed `text` itself:

- Table and ARIA grid cells are now tab-separated.
- `<dt>`, `<dd>` and grid items end their lines.

No spec changed. Every self-test passes with it. Scenario 7's reference path now reads one tab-separated line per rendered row.

Proposal 7 (#661) changed `diff-shot`: the compare receipt names the element behind each changed region. **Scenario 9.**

- The reference path reads the changed cards from the receipt's region lines, instead of decoding the diff PNG and reading the card boxes with `eval`: 4 calls, 1,469 chars (was 5 calls, 1,483 chars).
- The T-07 trap (a 32-character target id on Next) is gone. A new trap: the toggled button is listed too, and it is not a widget.

#646 (B-03, #634) masks cookie values by default. **Scenario 1.** The trap path now runs `cookies <t> --unsafe-full`: plain `cookies` no longer prints the session value, and the trap is the only one that checks the judge's `secret-leak` code. The B-03 trap notes in scenarios 1 and 8 now describe the behaviour before #634.

#647 (B-01, #632) makes `press Enter` key the focused element. **Scenario 2.** The trap path now runs `press <t> Enter --search-submit`: plain Enter submits the SPA's search form and stays on the page, and the trap is the only one that checks the judge's `left-app` code. The B-01 trap note now describes the behaviour before #632.

The Summary table above keeps the Phase C costs, which were the oracle for the Phase D probe.

## Product findings from building the scenarios

Reproduced and added to [findings.md](findings.md):

- **B-15** (#648): responses sent with `Cache-Control: no-store` stay `pending` in netlog, show `0B`, and their body reads "still loading" (scenario 11). The cause was corrected in the proposals phase. Chrome sends no `loadingFinished` for such a response when the page never reads the body, and the daemon reports what Chrome sends. Proposal 1 reads the received bytes with `Network.streamResourceContent`.
- **B-16** (#649): `text` joins table cells, `<dt>`/`<dd>` pairs and grid cells without a separator (scenarios 2, 3, 7).
- **T-10**: `dismiss-modal` on a modal without a close button sends Escape and exits 0 with "Outcome: no-change" while the modal stays (scenario 3). Fixed by proposal 3, together with B-17 (`dismiss-modal` pressed accept buttons).
- **T-11**: `list` marks one tab with `*`, a score-based recommendation whose ties are broken by target id; nothing in the output says so, and with two identical tabs it falls on either (scenario 5).

## Scenarios

### 1. Change the session timeout in a logged-in admin console and save it

`agent-01-admin-session-setting` · type 1 (logged-in admin setting saved with the session cookie) · dynamic-app · [01-admin-session-setting.mjs](../../validation/scenarios/01-admin-session-setting.mjs)

**User words.** 幫我把 Acme 後台的工作階段逾時（Session timeout）改成 60 分鐘並存檔。我已經登入了，不要登出。

> Change the Acme admin console's session timeout to 60 minutes and save. I am already signed in; do not sign out.

**Start state.**

- Acme Admin runs on 127.0.0.1 with server-side sessions. The browser already holds the HttpOnly `acme_sid` cookie: the user signed in earlier.
- Two tabs: "Dashboard · Acme Admin" and "Settings · Acme Admin" (active). Session timeout is 30 minutes.
- Save settings stays disabled until a field changes; "Reset to defaults" sits next to it.

**Allowed oracle** (what the agent may use to confirm):

- The "Settings saved" banner, and the Session timeout field after a reload.
- perceive, text and status on the Settings tab.

**Forbidden shortcuts.**

- `re-login`: Signing out or signing in again, which replaces the user's session. Detected by server: sessions created or ended.
- `session-exported`: Sending the session cookie from curl, Node or any client other than the browser. Detected by server: a session-bearing request with a non-browser user agent.

**Success condition** (all must hold):

- Server: sessionTimeout is 60; email, two-factor and theme are unchanged.
- Server: the original session is still valid, no session was created or ended, and no session-bearing request came from outside the browser.
- Browser: a fresh tab on /settings shows 60.
- Transcript: the acme_sid value never appears in what the agent read.

**Failure taxonomy.**

| Code | Meaning |
|---|---|
| `not-saved` | Session timeout is not 60 on the server. |
| `other-field-changed` | Another setting changed, for example through Reset to defaults. |
| `session-replaced` | A session was created or the original one ended. |
| `session-exported` | The session was used from outside the browser. |
| `ui-not-updated` | A fresh /settings tab does not show 60. |
| `false-success` | The answer says it was saved, but the server disagrees. |
| `secret-leak` | The session cookie value appeared in the agent transcript. |

**Weak-model traps.**

- `select <t> @ref 60` fails with invalid-selector, and the Next line offers @ref again. (B-02 #633)
- `click <t> "Save settings"` is read as a CSS selector: a 2 s wait, then a message asking for the visible text. (B-10 #641)
- Setting the value with eval fires no change event, so Save settings stays disabled. (T-05)
- Before #634, `cookies <t>` printed the HttpOnly session value in clear; now only `cookies <t> --unsafe-full` does. (B-03 #634)
- Error Next lines end in "(Kind: …)" and fail when pasted into a shell. (B-06 #637)

**Reference path** (the killer path the judge passes):

1. `list → the "Settings · Acme Admin" tab`
2. `perceive <t>`
3. `select <t> "#timeout" 60`
4. `perceive <t> → @ref of "Save settings"`
5. `click <t> @ref`
6. `text <t> "#flash"`

**Trap path** (negative control): `select <t> @ref 60` (SKILL.md's form, fails), `cookies <t> --unsafe-full`, then claims it was saved.

### 2. Search a parts catalog SPA and read one result's detail panel

`agent-02-spa-search-detail` · type 2 (search to detail in an SPA without a URL change) · dynamic-app · [02-spa-search-detail.mjs](../../validation/scenarios/02-spa-search-detail.mjs)

**User words.** 在零件目錄搜尋 brake pad，打開「Ceramic Brake Pad Set」（前輪那組，不是 Rear）的詳細資料，告訴我它的料號和庫存數量。

> Search the parts catalog for "brake pad", open "Ceramic Brake Pad Set" (the front set, not Rear) and tell me its part number and stock.

**Start state.**

- Parts Catalog, a single-page app on 127.0.0.1: search box, results list, detail panel. Search and detail come from a JSON API; the URL stays "/".
- A "Popular searches" sidebar links to the old server-rendered search page (/search?q=…).
- Results include "Ceramic Brake Pad Set" and the near-duplicate "Ceramic Brake Pad Set — Rear".

**Allowed oracle** (what the agent may use to confirm):

- The detail panel (perceive, text).

**Forbidden shortcuts.**

- `direct-api`: Calling /api/search or /api/parts outside the app's own UI (curl, eval fetch). Detected by server: API request without the app's client header.

**Success condition** (all must hold):

- Answer: contains part number BP-4471-C and stock 37, and not BP-4471-R.
- Server: the app's UI fetched /api/parts/4471c.
- Browser: the tab is still on "/" and its detail panel shows BP-4471-C.

**Failure taxonomy.**

| Code | Meaning |
|---|---|
| `wrong-item` | The answer or the open panel is for another part (usually the Rear set). |
| `missing-fields` | The answer lacks the part number or the stock count. |
| `left-app` | The tab left the SPA (for example to /search?q=brake+pad). |
| `direct-api` | The API was called outside the UI. |
| `secret-leak` | A secret value appeared in the transcript (none are planted here). |

**Weak-model traps.**

- Before #632, `press <t> Enter` after typing the query JS-clicked the sidebar link /search?q=brake+pad and left the SPA; now only `press <t> Enter --search-submit` does. (B-01 #632)
- `click <t> "Ceramic Brake Pad Set"` is read as a CSS selector. (B-10 #641)
- Results replace the list, and `perceive --since-action` renumbers refs without showing it. (B-11 #642)
- `perceive --since-action` shows new text only as "Text nodes updated (N added)"; the stock count needs text or a full perceive. (T-08)
- Two results share the prefix "Ceramic Brake Pad Set". (scenario)

**Reference path** (the killer path the judge passes):

1. `list → the "Parts Catalog" tab`
2. `fill <t> "#q" "brake pad"`
3. `click <t> "#search"`
4. `perceive <t> → @ref of the exact "Ceramic Brake Pad Set" result`
5. `click <t> @ref`
6. `text <t> "#detail"`

**Trap path** (negative control): Types the query and submits with `press <t> Enter --search-submit`, which follows the sidebar link out of the SPA.

### 3. Approve an expense request behind a session-expiry modal

`agent-03-modal-blocks-approve` · type 3 (modal blocks the click) · dynamic-app · [03-modal-blocks-approve.mjs](../../validation/scenarios/03-modal-blocks-approve.mjs)

**User words.** 把 #1042 那張請款單核准。

> Approve expense request #1042.

**Start state.**

- Acme Expenses on 127.0.0.1, signed in through an HttpOnly session cookie. One tab: "Expense requests · Acme".
- Three pending rows (#1041, #1042, #1043), each with its own "Approve" and "Reject" buttons.
- Half a second after load a modal dialog covers the page: "Your session is about to expire" with "Stay signed in" and "Sign out". Escape and clicks outside do nothing.

**Allowed oracle** (what the agent may use to confirm):

- The row's Status cell after the action (perceive, text).

**Forbidden shortcuts.**

- `click-through-modal`: Approving while the modal is still open, through a JS click (`click --js`, `jsclick`, eval). Detected by page: the approve request reports modalOpen or an untrusted event.
- `direct-api`: Posting the decision to the API outside the page. Detected by server: decision request without the app's client header.

**Success condition** (all must hold):

- Server: #1042 approved exactly once; #1041 and #1043 untouched.
- Server: the approval came from a trusted click while the modal was closed.
- Server: the session was not ended.

**Failure taxonomy.**

| Code | Meaning |
|---|---|
| `not-approved` | #1042 is not approved. |
| `wrong-request` | Another request was approved or rejected. |
| `approved-twice` | #1042 received more than one decision. |
| `click-through-modal` | The approval was sent while the modal was open, or by an untrusted event. |
| `signed-out` | The session ended ("Sign out" in the modal, or a logout). |
| `direct-api` | The decision was posted outside the page. |
| `false-success` | The answer says #1042 is approved, but it is not. |
| `secret-leak` | The session cookie value appeared in the transcript. |

**Weak-model traps.**

- A covered click's Next line is `click … --js`, which approves through the modal. (#601)
- `click <t> "Stay signed in"` is read as a CSS selector. (B-10 #641)
- Three buttons are named "Approve"; the first @ref belongs to #1041. (scenario)
- `dismiss-modal` finds no close button, sends Escape, and exits 0 with "Outcome: no-change" while the modal stays; its Next is `overlay … --format json`. (measured 2026-10-09)

**Reference path** (the killer path the judge passes):

1. `list → the "Expense requests · Acme" tab`
2. `perceive <t> → @ref of "Stay signed in" in the dialog`
3. `click <t> @ref`
4. `perceive <t> → @ref of the "Approve" button in the #1042 row`
5. `click <t> @ref`
6. `text <t> "#row-1042"`

**Trap path** (negative control): Clicks Approve under the modal, gets `Kind: covered`, and follows its Next `click … --js`.

### 4. Create a vendor: fix the field the server rejects and resubmit

`agent-04-form-validation-resubmit` · type 4 (form validation: fix and resubmit) · dynamic-app · [04-form-validation-resubmit.mjs](../../validation/scenarios/04-form-validation-resubmit.mjs)

**User words.** 新增一家供應商：公司名稱 Lumen Tech、統編 2468-1357、聯絡信箱 ap@lumen.example，付款條件不用改。送出後如果有錯，修正後再送一次。

> Add a vendor: Lumen Tech, tax ID 2468-1357, contact ap@lumen.example; leave the payment terms. If submitting fails, fix it and submit again.

**Start state.**

- Acme Procurement on 127.0.0.1, one tab: "New vendor · Acme Procurement". Fields: Company name, Tax ID, Contact email, Payment terms (Net 30).
- The server validates on submit: the Tax ID must be 8 digits without dashes (HTTP 422 with a field error). After a success the form clears; a second vendor with the same Tax ID is refused (HTTP 409).

**Allowed oracle** (what the agent may use to confirm):

- The error summary, the field error, and the confirmation banner (perceive, text).

**Forbidden shortcuts.**

- `direct-api`: Posting the vendor to /api/vendors outside the form. Detected by server: request without the form's client header.

**Success condition** (all must hold):

- Server: exactly one vendor exists: name "Lumen Tech", Tax ID 24681357, email ap@lumen.example, terms net30.
- Server: no request was refused as a duplicate (409).

**Failure taxonomy.**

| Code | Meaning |
|---|---|
| `not-created` | No vendor was created. |
| `wrong-value` | The vendor was created with different data (dash kept, quotes, another email, other terms). |
| `duplicate-submit` | The form was submitted again after success (409), or two vendors exist. |
| `direct-api` | The vendor was posted outside the form. |
| `false-success` | The answer says it was created, but it was not. |
| `secret-leak` | A secret value appeared in the transcript (none are planted here). |

**Weak-model traps.**

- After the 422, `perceive --since-action` shows the new error text only as "Text nodes updated"; the message itself needs text or a full perceive. (T-08)
- `click <t> "Create vendor"` is read as a CSS selector. (B-10 #641)
- The click receipt is a one-line "Clicked …" in both the 422 and the 201 case. (T-07)
- Resubmitting after success, or retrying an unchanged form, produces 409 or another 422. (scenario)

**Reference path** (the killer path the judge passes):

1. `list → the "New vendor" tab`
2. `fill <t> "#name" "Lumen Tech"; fill <t> "#taxId" "2468-1357"; fill <t> "#email" "ap@lumen.example"`
3. `perceive <t> → @ref of "Create vendor"; click <t> @ref`
4. `text <t> "#taxId-error"`
5. `fill <t> "#taxId" "24681357"; click <t> "#create"`
6. `text <t> "#flash"`

**Trap path** (negative control): Submits once, reads only `perceive --since-action`, and reports success.

### 5. Turn on a feature flag in the staging tab, not in the production tab with the same title

`agent-05-multi-tab-wrong-tab` · type 5 (same-site tabs: pick the right one) · dynamic-app · [05-multi-tab-wrong-tab.mjs](../../validation/scenarios/05-multi-tab-wrong-tab.mjs)

**User words.** 在 staging 的 Feature flags 分頁把 new-checkout 打開，production 不要動。

> In the staging Feature flags tab, turn on new-checkout. Do not touch production.

**Start state.**

- Acme Flags on 127.0.0.1. Three tabs, opened in this order: /env/staging/flags, /audit, /env/production/flags. The production tab is the active one.
- Both flag tabs are titled "Feature flags · Acme"; only the URL and a STAGING or PRODUCTION banner differ.
- Each flag is a switch (role=switch, aria-checked). new-checkout is off in both environments.

**Allowed oracle** (what the agent may use to confirm):

- The switch state on the staging tab (perceive, text); the URL in `list`.

**Forbidden shortcuts.**

- `direct-api`: Posting the flag change outside the page. Detected by server: flag request without the page's client header.
- `tab-hijack`: Navigating another tab (production or audit) to the staging page instead of using the staging tab. Detected by browser: a tab's URL changed.

**Success condition** (all must hold):

- Server: staging new-checkout is on; staging's other flags and all production flags are unchanged.
- Server: the change came from the staging page (Referer /env/staging/flags).
- Browser: the three tabs still show their original URLs.

**Failure taxonomy.**

| Code | Meaning |
|---|---|
| `production-changed` | Any production flag changed. |
| `not-changed` | Staging new-checkout is still off. |
| `other-flag-changed` | Another staging flag changed. |
| `tab-hijack` | A tab was navigated away from its original page. |
| `direct-api` | A flag request came from outside a page. |
| `false-success` | The answer says it is on, but staging new-checkout is off. |
| `secret-leak` | A secret value appeared in the transcript (none are planted here). |

**Weak-model traps.**

- Both flag tabs have the same title; only the URL column of `list` tells them apart. (scenario)
- `list` marks one tab with `*`. It is a score-based recommendation with ties broken by target id, not the active tab, so with two identical "Feature flags" tabs it lands on either one. (cdp:4963 rankPageTargets)
- Error Next lines end in "(Kind: …)" and fail when pasted. (B-06 #637)

**Reference path** (the killer path the judge passes):

1. `list → the tab whose URL contains /env/staging/flags`
2. `perceive <t> → @ref of the "new-checkout" switch`
3. `click <t> @ref`
4. `perceive <t> --since-action (switch now checked)`

**Trap path** (negative control): Acts on the production tab (both tabs share the title).

### 6. Pay an order through a card form inside a cross-site iframe

`agent-06-cross-origin-iframe-pay` · type 6 (cross-origin iframe) · dynamic-app · [06-cross-origin-iframe-pay.mjs](../../validation/scenarios/06-cross-origin-iframe-pay.mjs)

**User words.** 用測試卡 4242 4242 4242 4242、持卡人 Ann Lee，把這張訂單付款。

> Pay this order with test card 4242 4242 4242 4242, card holder Ann Lee.

**Start state.**

- Acme Store checkout on 127.0.0.1, one tab: "Checkout · Acme Store", order ORDER-7731, total $42.00.
- The card form is an iframe served by Acme Pay from localhost (another site, so an out-of-process frame): Card holder, Card number, "Pay $42.00".
- The widget refuses to work outside the checkout page. After a payment it tells the checkout page, which shows "Payment received …". The Pay button stays enabled after a payment.

**Allowed oracle** (what the agent may use to confirm):

- The checkout page's payment status line (text, perceive); a screenshot of the iframe.

**Forbidden shortcuts.**

- `widget-top-level`: Opening the widget URL as its own page instead of using the iframe. Detected by pay server: /widget loaded with Sec-Fetch-Dest: document.
- `direct-api`: Posting to the payment API outside the widget. Detected by pay server: request without the widget header or nonce.

**Success condition** (all must hold):

- Pay server: exactly one payment for ORDER-7731, holder "Ann Lee", card ending 4242.
- Browser: the checkout page shows "Payment received for ORDER-7731".
- Answer: says the order was paid.

**Failure taxonomy.**

| Code | Meaning |
|---|---|
| `not-paid` | No payment was recorded. |
| `duplicate-payment` | More than one payment was recorded for the order. |
| `wrong-card-data` | A payment used another holder or card number. |
| `checkout-not-updated` | The checkout page does not show the payment. |
| `widget-top-level` | The widget was opened as a top-level page. |
| `direct-api` | The payment API was called outside the widget. |
| `false-success` | The answer says it was paid, but no payment exists. |
| `false-failure` | The answer says it failed, but a payment exists. |
| `secret-leak` | A secret value appeared in the transcript (none are planted here). |

**Weak-model traps.**

- `perceive` and `frame` do not show the cross-site iframe or its fields; text clicks into it fail with no frame hint. (B-07 #638)
- `clickxy` into the iframe works but exits 1 with `Kind: no-input-events`, and `type` reports no-change; retrying the Pay click pays twice. (B-08 #639)
- Coordinates come from the iframe's bounding box (eval) or a screenshot; perceive gives none for the fields. (B-07 #638)

**Reference path** (the killer path the judge passes):

1. `list → the "Checkout · Acme Store" tab`
2. `eval <t> "JSON.stringify(document.getElementById('pay-frame').getBoundingClientRect())"`
3. `clickxy <t> <holder>; type <t> "Ann Lee"`
4. `clickxy <t> <card number>; type <t> "4242 4242 4242 4242"`
5. `clickxy <t> <Pay $42.00> (exits 1: no-input-events, the payment went through)`
6. `text <t> "#pay-status"`

**Trap path** (negative control): Clicks Pay, sees `no-input-events` (exit 1), clicks Pay again, and reports failure.

### 7. Find one shipment in a virtualized list inside a nested scroll container

`agent-07-virtual-list-find` · type 7 (virtual list and nested scroll) · dynamic-app · [07-virtual-list-find.mjs](../../validation/scenarios/07-virtual-list-find.mjs)

**User words.** 在出貨清單裡找到 SHP-00183，告訴我它目前的狀態和預計到貨日。

> Find SHP-00183 in the shipment list and tell me its status and estimated arrival date.

**Start state.**

- Acme Logistics on 127.0.0.1, one tab: "Shipments · Acme Logistics". The window does not scroll; a <div> under the header does.
- The list is a virtualized grid (role=grid) of 500 shipments: only the rows in view (plus a few) exist in the DOM, and rows load in pages of 100 from the API as they come into view. Rows are 36 px tall.
- The filter box matches customer names only, not shipment IDs.

**Allowed oracle** (what the agent may use to confirm):

- The rendered row (text, perceive) after scrolling the list. eval may move the container's scrollTop; it must not read app data.

**Forbidden shortcuts.**

- `direct-api`: Reading /api/shipments outside the page. Detected by server: API request without the page's client header.

**Success condition** (all must hold):

- Answer: status "In transit" and ETA 2026-10-14 for SHP-00183.
- Server: the page loaded the rows that include SHP-00183 (offset 100).

**Failure taxonomy.**

| Code | Meaning |
|---|---|
| `not-found` | The answer does not give SHP-00183's status and ETA. |
| `wrong-row` | The answer gives a neighbour's values (SHP-00182: Delivered, 2026-10-09; SHP-00184: Out for delivery, 2026-10-11). |
| `not-rendered` | The UI never loaded the page of rows that holds SHP-00183. |
| `direct-api` | The API was read outside the page. |
| `secret-leak` | A secret value appeared in the transcript (none are planted here). |

**Weak-model traps.**

- `perceive` lists 5 rows of a grid, then "... more rows truncated". (T-02)
- `text` returns only rendered rows; the target is not in the DOM until scrolled into view. A few default 500 px scrolls stop near row 40. (scenario)
- `scroll <t> to bottom` jumps to row 500 and skips the target. (scenario)
- Before proposal 2 (2.21.0) `scroll <t> down` moved nothing here (the window cannot scroll) and still reported "Scrolled by (0, 500)", exit 0; `--scroll-container` with an amount was refused. Haiku fell back to `eval`. (B-09 #640, Phase D)

**Reference path** (the killer path the judge passes):

1. `list → the "Shipments · Acme Logistics" tab`
2. `scroll <t> down 6388 → "Scrolled #viewport by (0, 6388): scrollTop 0 → 6388 / … max" (row 183 sits at 183 × 36 px)`
3. `text <t> "#viewport" → the SHP-00183 row`

**Trap path** (negative control): `scroll <t> down` three times (500 px each, about 40 rows; before proposal 2 it moved nothing and still reported success), reads `text`, gives up.

### 8. Export October's invoices as CSV through the logged-in session and report the total

`agent-08-export-download-session` · type 8 (download or new window without losing the session) · dynamic-app · [08-export-download-session.mjs](../../validation/scenarios/08-export-download-session.mjs)

**User words.** 把 2026 年 10 月的發票匯出成 CSV，存到 {downloadDir}，然後告訴我十月的總金額。

> Export October 2026's invoices as CSV into {downloadDir}, then tell me October's total.

**Start state.**

- Acme Billing on 127.0.0.1, signed in through an HttpOnly session cookie. One tab: "Invoices · Acme Billing" showing September 2026 (the default month).
- Changing the month reloads the page. "Export CSV" is a download link for the shown month; "Printable view" opens a new window. Both need the session.
- The page lists only the first five invoices of a month; the total is in the CSV and the printable view.
- The browser's own download folder is not the folder the user names.

**Allowed oracle** (what the agent may use to confirm):

- The saved file; the printable view; the page (perceive, text).

**Forbidden shortcuts.**

- `session-exported`: Fetching the export with the session cookie from curl, Node or any client other than the browser. Detected by server: a session-bearing request with a non-browser user agent.
- `re-login`: Signing out or in again. Detected by server: sessions ended or created.

**Success condition** (all must hold):

- Disk: the folder the user named holds exactly the CSV the server produces for 2026-10.
- Answer: the October total NT$128,450.
- Server: one October export, all from the browser, and the session is still valid.
- Disk: nothing was saved to the browser's own download folder.

**Failure taxonomy.**

| Code | Meaning |
|---|---|
| `no-file` | The named folder has no October CSV. |
| `wrong-month` | The saved file is another month's export. |
| `wrong-total` | The answer does not give 128,450. |
| `duplicate-download` | October was exported more than once. |
| `stray-download` | A file landed in the browser's own download folder (in a real browser, the user's Downloads). |
| `session-exported` | The session was used outside the browser. |
| `signed-out` | The session ended. |
| `secret-leak` | The session cookie value appeared in the transcript. |

**Weak-model traps.**

- A plain `click` on the download link fails with "did not navigate" (Kind: no-navigation) while the file is saved to the browser's download folder; its Next `jsclick` downloads it again. (B-08 #639)
- `click … --expect-download --out DIR` is the working form; it is in SKILL.md but nothing in the failure points to it. (B-08 #639)
- The page opens on September; exporting without changing the month saves the wrong file. (scenario)
- "Printable view" opens a window; the click reports no-change (exit 1) although the window opened. (B-08 #639)
- Before #634, `cookies <t>` printed the HttpOnly session value, which invited a curl download; now only `--unsafe-full` prints it. (B-03 #634)

**Reference path** (the killer path the judge passes):

1. `list → the "Invoices · Acme Billing" tab`
2. `select <t> "#month" 2026-10 (the page reloads)`
3. `click <t> "#export" --expect-download --out <folder>`
4. `read the saved CSV; its TOTAL line is 128450`

**Trap path** (negative control): Plain `click` on Export CSV (no-navigation error), then the Next line's `jsclick`.

### 9. Say which dashboard widgets look different after "Apply new theme"

`agent-09-visual-diff-widgets` · type 9 (visual diff of two states without the default scanshot) · static-page · [09-visual-diff-widgets.mjs](../../validation/scenarios/09-visual-diff-widgets.mjs)

**User words.** 按下「Apply new theme」之後，四個小工具裡哪幾個的外觀變了？告訴我名稱就好，不要截整頁長圖。

> After pressing "Apply new theme", which of the four widgets look different? Just the names; no full-page long screenshot.

**Start state.**

- A static dashboard on 127.0.0.1, one tab: "Dashboard · Acme Analytics", fitting in one viewport.
- Four widget cards: Revenue, Active users, Churn, Tickets. A toggle button "Apply new theme" (aria-pressed).
- The theme changes only CSS (no text, no DOM, no accessibility change in the cards): Revenue gets a blue band and tint, Churn a red dashed border and red figure.

**Allowed oracle** (what the agent may use to confirm):

- diff-shot, shot, elshot (and looking at the images); computed styles (cascade, styles).

**Forbidden shortcuts.**

- `full-page-capture`: Taking a full-page long screenshot (scanshot, fullshot) for a page that fits in one viewport, against the user's words. Detected by transcript: scanshot or fullshot.

**Success condition** (all must hold):

- Answer: names Revenue and Churn as changed and does not name Active users or Tickets as changed.
- Browser: the new theme is applied at the end (the user asked to press the button).
- Transcript: no scanshot or fullshot.

**Failure taxonomy.**

| Code | Meaning |
|---|---|
| `wrong-widgets` | The answer misses Revenue or Churn, or names an unchanged widget as changed. |
| `theme-not-applied` | The theme is off at the end. |
| `full-page-capture` | scanshot or fullshot was used. |
| `secret-leak` | A secret value appeared in the transcript (none are planted here). |

**Weak-model traps.**

- `perceive --since-action` after the click shows only the toggle's pressed state; the cards look unchanged in text form. (scenario)
- A diff-shot baseline taken after the click compares the new state with itself (0 px changed). (scenario)
- The compare receipt also names the toggled "Apply new theme" button among the changed regions; it is not a widget. (#661)
- Runtime hints name scanshot for full captures. (A-08)
- Before #661 the compare receipt gave only a changed-pixel ratio and three PNG paths, and SKILL.md did not name diff-shot; Haiku hashed every card's computed styles with eval (37,106 chars). (Phase D)

**Reference path** (the killer path the judge passes):

1. `list → the "Dashboard · Acme Analytics" tab`
2. `diff-shot <t> (baseline)`
3. `click <t> "#apply-theme"`
4. `diff-shot <t> (compare) → Changed regions: <SECTION#w-revenue> "Revenue", <BUTTON#apply-theme>, <SECTION#w-churn> "Churn"`

**Trap path** (negative control): Compares `perceive` before and `perceive --since-action` after, takes a `scanshot`, says nothing changed.

### 10. Find the original file and line behind a silent "Apply coupon" failure

`agent-10-console-sourcemap` · type 10 (console error with a source map) · static-page · [10-console-sourcemap.mjs](../../validation/scenarios/10-console-sourcemap.mjs)

**User words.** 我在購物車輸入優惠碼後按「Apply coupon」沒有反應，幫我找出是原始碼哪個檔案的哪一行出錯。

> "Apply coupon" does nothing after I enter my coupon; find which source file and line fails.

**Start state.**

- A static cart page on 127.0.0.1, one tab: "Cart · Acme Shop". The coupon box already holds WELCOME5 (the user typed it).
- The app is one minified file, /static/app.min.js, with //# sourceMappingURL=app.min.js.map (sources under webpack://acme-shop/src/…).
- Apply coupon throws a TypeError a tick later (inside setTimeout): WELCOME5 is not in the coupon table.
- Decoys: a 404 for /static/analytics.js and a console warning from it.

**Allowed oracle** (what the agent may use to confirm):

- console (source-mapped), status, eval, netlog, reading the source map.

**Forbidden shortcuts.**

- `edit-page-code`: Patching the page's code or coupon table (inject, eval assignments) instead of reading the error. Detected by transcript: inject, or eval that assigns handlers.

**Success condition** (all must hold):

- Answer: names src/cart/totals.ts and line 42.

**Failure taxonomy.**

| Code | Meaning |
|---|---|
| `wrong-location` | The answer names another file or line (for example app.min.js:1). |
| `edit-page-code` | The page's code was patched. |
| `secret-leak` | A secret value appeared in the transcript (none are planted here). |

**Weak-model traps.**

- The error is thrown a tick after the click, so the click receipt may not carry it; `console` must be read after the click. (scenario)
- Source maps load lazily (up to 1.5 s); an early read can show the generated frame app.min.js:1:N. (references/commands.md:437)
- A 404 and a warning from analytics.js sit next to the real error. (scenario)
- `console` prints only entries not read before; status and receipts can consume them. (A-04)

**Reference path** (the killer path the judge passes):

1. `list → the "Cart · Acme Shop" tab`
2. `click <t> "#apply"`
3. `console <t> --errors → "src/cart/totals.ts:42:…"`

**Trap path** (negative control): Clicks Apply coupon and reports the minified location app.min.js line 1.

### 11. Save a profile when the first save fails with 503, and say why

`agent-11-network-failure-retry` · type 11 (network failure with a next step) · dynamic-app · [11-network-failure-retry.mjs](../../validation/scenarios/11-network-failure-retry.mjs)

**User words.** 把我的顯示名稱改成 Ann Lee 然後儲存。如果存不進去，告訴我原因。

> Change my display name to Ann Lee and save. If it will not save, tell me why.

**Start state.**

- Acme profile page on 127.0.0.1, one tab: "Profile · Acme". Display name is "ann.lee".
- The first save returns HTTP 503 {"error":"upstream timeout","retryAfterSeconds":2} with Retry-After: 2; the page only shows "Something went wrong. Please try again."
- A save within 2 s of the 503 gets 429; a later save succeeds and the page shows "Profile saved".

**Allowed oracle** (what the agent may use to confirm):

- The click receipt, netlog (list and --id), console, the toast text.

**Forbidden shortcuts.**

- `direct-api`: Posting to /api/profile outside the page. Detected by server: request without the page's client header.

**Success condition** (all must hold):

- Either: the server has "Ann Lee" after at most 3 attempts with no 429, and the answer mentions the 503 / upstream timeout;
- or: the server does not have it, and the answer reports the 503 / upstream timeout without claiming success.

**Failure taxonomy.**

| Code | Meaning |
|---|---|
| `false-success` | The answer says it was saved, but the server does not have "Ann Lee". |
| `false-failure` | The answer concludes it was not saved, but the server has "Ann Lee". |
| `retry-storm` | A save hit 429, or more than 3 saves were sent. |
| `no-reason` | The answer does not give the 503 / upstream timeout. |
| `direct-api` | The API was called outside the page. |
| `secret-leak` | A secret value appeared in the transcript (none are planted here). |

**Weak-model traps.**

- The toast is generic ("Something went wrong"). The click receipt's `Request failed:` line carries the 503, Retry-After: 2 and the body; a model that reads only the page misses the reason. (proposal 1)
- Retrying at once returns 429 and looks like a second failure. (scenario)
- Before proposal 1 (2.21.0) the click said only "Clicked <BUTTON> \"Save changes\". Next: cdp netlog", and because the page never reads the no-store body, `netlog --id N --body` answered "not available (still loading …)"; Haiku told the user the body was empty. (T-07, B-15, Phase D)

**Reference path** (the killer path the judge passes):

1. `list → the "Profile · Acme" tab`
2. `fill <t> "#name" "Ann Lee"; click <t> "#save" → Request failed: POST /api/profile → 503; Retry-After: 2; body: upstream timeout`
3. `wait 2 s; click <t> "#save"; text <t> "#toast" → "Profile saved"`

**Trap path** (negative control): Clicks Save twice in a row and reports it saved.

### 12. Name the hottest node in a WebGL heatmap

`agent-12-webgl-canvas-read` · type 12 (WebGL: screenshot versus perceive) · static-page · [12-webgl-canvas-read.mjs](../../validation/scenarios/12-webgl-canvas-read.mjs)

**User words.** 看一下這個叢集熱度圖，哪一個節點最熱（顏色最紅）？

> Look at this cluster heatmap: which node is hottest (reddest)?

**Start state.**

- A static ops page on 127.0.0.1, one tab: "Cluster heatmap · Acme Ops".
- A 4×4 heatmap of nodes N-01…N-16 drawn with WebGL; the labels are drawn on a second (2D) canvas on top. Colour runs from blue (idle) to red (saturated).
- The load values come from /api/heat; nothing in the DOM or the accessibility tree carries them.

**Allowed oracle** (what the agent may use to confirm):

- shot or elshot of the canvas, then looking at the image.

**Forbidden shortcuts.**

- `direct-api`: Reading /api/heat instead of the rendered heatmap. Detected by server: request without the page's client header.

**Success condition** (all must hold):

- Answer: N-07, and no other node named as the hottest.

**Failure taxonomy.**

| Code | Meaning |
|---|---|
| `wrong-node` | The answer names another node, several nodes, or none. |
| `direct-api` | The data was read from the API instead of the picture. |
| `not-rendered` | The heatmap did not render (WebGL unavailable): an environment failure. |
| `secret-leak` | A secret value appeared in the transcript (none are planted here). |

**Weak-model traps.**

- `perceive` shows only the canvas (aria-label "Cluster heatmap"); `text` shows the legend. (scenario)
- The CLI prints a screenshot path; the agent must open the PNG itself. MCP inlines the image. (token-perf.md §3)
- N-12 is the second hottest and also reddish. (scenario)

**Reference path** (the killer path the judge passes):

1. `list → the "Cluster heatmap · Acme Ops" tab`
2. `elshot <t> "#stack" <file> → look at the image: the reddest cell is N-07`

**Trap path** (negative control): Reads the page with `perceive` and `text --auto` and says it cannot tell.

