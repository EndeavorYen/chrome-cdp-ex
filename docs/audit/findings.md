# Phase B: defects and architecture findings

Audit of chrome-cdp-ex 2.21.0 at `21e96b5`, run on 2026-10-09. Phase A's inventory is [command-surface.md](command-surface.md); token and latency numbers are in [token-perf.md](token-perf.md).

Every finding below was reproduced on a live browser, or by a deterministic function call where a live run would have touched the user's own browser. None comes from reading code alone; code locations explain causes.

## Setup

- Host: Windows 11 Home 10.0.26300, Node v24.21.0, Google Chrome 154.0.8037.98 started as `--headless=new --remote-debugging-port=9555 --user-data-dir=<scratch profile> --window-size=1280,900`. The user's daily Chrome (DevToolsActivePort 3048) and Edge (9222) were never contacted.
- Every CLI call: `CDP_PORT=9555 LOCALAPPDATA=<scratch>/runtime node skills/chrome-cdp-ex/scripts/cdp.mjs …`. `CDP_PORT` short-circuits discovery (`cdp:4362`); the `LOCALAPPDATA` override keeps endpoint records and daemon state out of the real runtime directory.
- Fixtures: `node docs/audit/fixtures/phase-b-server.mjs 41801` serves every page named below at `http://127.0.0.1:41801`. The same server reached as `http://localhost:41801` is another site, which gives a cross-site (out-of-process) iframe.
- An AdGuard filter on this host injects `local.adguard.org` scripts into HTTP responses. No finding depends on it: every repro reads the page state back with `eval`.
- In repro output, `<t>` stands for the tab's 8-character target prefix.

Prefixes: `cdp:` = `skills/chrome-cdp-ex/scripts/cdp.mjs`, `ar:` = `scripts/lib/action-recovery.mjs`, `cs:` = `scripts/lib/command-surface.mjs`, `mcp:` = `scripts/lib/mcp-adapter.mjs`.

Classes:

- **WRONG**: the tool does, reports or advises the wrong thing, so an agent that trusts it takes a wrong or harmful next step.
- **BUG**: a defect whose effect is contained (time, flakiness) and does not mislead the next step.
- **THIN**: the result is correct but leaves out something that changes the next move.
- **OK**: checked, holds.

## Summary

| ID | Class | Finding | From A | Issue |
|---|---|---|---|---|
| B-01 | WRONG | `press Enter` JS-clicks an unrelated "results" link instead of pressing Enter; `batch 'fill … \| press Enter'` never presses Enter outside huggingface.co | A-01 | #632 |
| B-02 | WRONG | `select` and `upload` reject the `@ref` that `perceive` hands out, and the recovery line advertises `@ref` | A-02 | #633 |
| B-03 | WRONG | `cookies`, `console`, `status`, `list`, `perceive`, `summary` and `checkpoint` print session cookies, JWTs and URL tokens in clear; receipts mask the same values | A-04 | #634 |
| B-04 | WRONG | Attach guidance contradicts itself across SKILL.md, references and doctor; doctor's only advice is a new, logged-out profile, and it drops the `CDP_PORT` hint | A-05 | #635 |
| B-05 | WRONG | Error `Kind` follows the page's wording, and one failure type gets different Kinds | A-07 | #636 |
| B-06 | WRONG | No `Next:` line runs when copied: `(Kind: …)` / `(ask first)` suffixes, a `cdp` command that is not installed, target-less templates | A-09 | #637 |
| B-07 | WRONG | Iframe content is invisible on the default observe path; cross-site iframes are missing from `frame` | A-19 | #638 |
| B-08 | WRONG | Clicks whose effect lands outside the top document (cross-site iframe, download, popup) are reported as failures, and Next repeats them | new | #639 |
| B-09 | WRONG | `scroll down` does not move a nested scroll container but reports success; `--scroll-container` is silently dropped | A-20 | #640 |
| B-10 | WRONG | `click "<two-word label>"` is parsed as CSS; `text=` works but JS-clicks through a cover | new | #641 |
| B-11 | WRONG | `perceive --since-action` renumbers every ref but prints only added/removed lines, so the next `@N` hits another control | new | #642 |
| B-12 | WRONG | MCP: `run_command` refuses the commands Next names; unlisted tools still answer; a refused click is 15.8 KB | A-03, A-06, A-12 | #643 |
| B-13 | BUG | `open` waits 1.5 s for a URL that cannot appear before it navigates | new | #644 |
| B-14 | BUG | `npm test` fails when `issue-366` runs before `issue-358` (shared endpoint record) | A-24 | #645 |
| B-15 | BUG | `netlog`: responses sent with `Cache-Control: no-store` stay pending, show 0B, and their body reads "still loading" | Phase C | #648 |
| B-16 | BUG | `text` joins table cells, `<dt>`/`<dd>` pairs and grid cells without a separator | Phase C | #649 |
| B-17 | WRONG | `dismiss-modal` presses an accept button ("OK, delete it", 確認) and reports "Dismissed" | proposals | #653 |
| T-01 … T-11 | THIN | see [THIN](#thin) | | |
| O-01 … O-15 | OK | see [OK](#ok) | | |

## WRONG

### B-01 `press Enter` is replaced by a click on an unrelated link; `batch 'fill … | press Enter'` fails on every other site

Repro 1, `/todo.html`: an input whose `keydown` Enter adds an item, and an aside link "See full election results".

```text
fill <t> "#todo" "buy milk"   → Filled <INPUT> with "buy milk".
press <t> Enter               → Error: Search submit via a[href="/news/election"] did not reach a results listing. Try jsclick a[href="/news/election"].
                                Kind: unknown                                               (exit 1)
eval → {"url":"http://127.0.0.1:41801/news/election","items":[]}
```

The tab left the form and no key was sent. The error then tells the agent to click the same unrelated link again.

Repro 2, same page with the aside link replaced by `<a href="/search?q=groceries">Recent: groceries</a>`:

```text
press <t> Enter → Pressed Enter. Submitted search via a[href="/search?q=groceries"]. Next: cdp perceive <t> --since-action   (exit 0)
eval → {"url":"http://127.0.0.1:41801/search?q=groceries","items":[]}
```

Exit 0 and "Pressed Enter", although no key was pressed and the typed item is gone.

Repro 3, `/todo-plain.html` (a form, no links at all):

```text
batch <t> 'fill #todo buy-bread | press Enter'
  press → Error: Search submit did not find a results listing after fill. Try jsclick a[href*="models?search="].  Kind: unknown   (exit 1)
eval → submits 0, input still "buy-bread"
press <t> Enter                              → Pressed Enter.   submits 1
flow <t> "fill #todo buy-jam; press Enter"   → submits 1   (flow has no lookahead)
```

Cause:

- On Enter, `press` looks for any visible `a[href]` whose href is a listing (`/search?q=`, `/?q=`, `/models?search=` …) or whose text matches `/\bsee\b[\s\S]{0,80}\bresults\b/i` (`cdp:13717-13740`, `cdp:18118-18142`). It does not look at the focused element. If one exists, it JS-clicks it instead of dispatching the key (`cdp:28670-28674`, `cdp:18274-18281`, `submitSearchListing` `cdp:18232-18267`).
- In `batch`, a `fill` followed by `press Enter` turns the fill `report-only` (`cdp:18073-18078`) and arms `awaitSearchSubmitListing` (`cdp:11179-11182`). The press then requires a listing (`cdp:18282-18286`); the only one it can synthesize is for `huggingface.co` (`cdp:18153-18174`).
- The behaviour came from benchmark work (#328, #337, #339) and is pinned by `tests/search-submit.test.mjs:603-606`.

Consequence: the most common submit gesture navigates a logged-in tab away from a half-filled form, or fails every login and search sent through `batch`.

### B-02 `select` and `upload` reject the `@ref` that `perceive` hands out

`/select.html`:

```text
perceive <t>        → [combobox] Plan = "Free"  @1 … [option] Pro  @3  (0,0 0×0)
select <t> @1 pro   → Error: SyntaxError: Failed to execute 'querySelector' on 'Document': '@1' is not a valid selector.
                      Kind: invalid-selector
                      Next: cdp select <t> <css|#id|[data-testid]|@ref> (Kind: invalid-selector)
click <t> @3        → Error: click: the control did not react (Outcome: no-change). Clicked <OPTION> "Pro" (@3)
select <t> "#plan" pro → Selected "Pro".
```

`/upload.html`:

```text
perceive <t>                 → [button] Avatar = "未選擇任何檔案"  @1      (the file input; the label is the browser locale's "No file chosen")
upload <t> @1 <file>         → Error: DOM Error while querying   Kind: unknown   Next: cdp perceive <t> -C -d 8
upload <t> "#file" <file>    → Uploaded 1 file(s) to #file … page shows "Chosen: avatar.png 12"
```

Cause: `selectStr` hands the argument to `document.querySelector` (`cdp:20104-20105`), `uploadStr` to `DOM.querySelector` (`cdp:22162`); neither resolves refs. The invalid-selector recovery advertises `@ref` (`ar:780`), and SKILL.md:17 teaches `select` with `@ref`. Plain `perceive` prints no CSS selector for a ref; only `-C` adds selectors, for the first 8 visible controls.

Consequence: following SKILL.md, then the Next line, repeats the same error; the agent has to guess `#plan`.

### B-03 Session cookies, JWTs and URL tokens are printed in clear by read commands

Fixture `/secrets.html?token=SECRET_URL_TOKEN_123&user=alice`. The server sets `sid=SECRET_SESSION_8f3k2q9; HttpOnly`; the page sets an `auth_jwt` cookie, logs a Bearer JWT and a URL with `access_token`, and fetches `/api/me` with `Authorization: Bearer <jwt>`.

| Command | Output (excerpt) | Masked |
|---|---|---|
| `nav` receipt | `…/secrets.html?token=<redacted>&user=alice` | yes |
| `netlog`, `netlog --id 12` | `token=<redacted>`; `Authorization: <redacted>`; `Cookie: <redacted>` | yes |
| `report` | `access_token=<redacted>`, `token=<redacted>` | yes |
| `cookies` | `sid  SECRET_SESSION_8f3k2q9 … HttpOnly`; `auth_jwt  eyJhbGciOiJIUzI1NiIsInR5cCI6Ik...` | **no** |
| `console` | `[log] calling /api/me with Authorization: Bearer eyJhbGciOi…` (whole JWT); `[error] …?access_token=SECRET_ACCESS_777&user=alice` | **no** |
| `status` | `URL: …?token=SECRET_URL_TOKEN_123&user=alice` | **no** |
| `list` | `<t>  Account  …?token=SECRET_URL_TOKEN_123&user=alice` | **no** |
| `perceive` | `Page: Account — …?token=SECRET_URL_TOKEN_123&user=alice` | **no** |
| `summary` | `URL: …?token=SECRET_URL_TOKEN_123&user=alice` | **no** |
| `checkpoint` | `URL: …?token=SECRET_URL_TOKEN_123&user=alice`, then `Privacy: default-redacted` | **no** |

Cause: redaction (`redactUrl`, `redactSensitiveString`) runs in the receipt, netlog and report builders (`cdp:8829`, `cdp:8835`, `cdp:9320-9323`, `cdp:9427`) and nowhere else. Unmasked sites: `cookies` cuts values at 30 characters (`cdp:20772`); `console` (`cdp:7071`, `cdp:7078`); `status` (`cdp:6988`, `cdp:7027`, `cdp:7038`); `list` (`cdp:4972` text, `cdp:5000` JSON); the perceive header (`cdp:15912`); `summary` (`cdp:7165`); `checkpoint` (`cdp:20887-20888`).

Consequence: this breaks "secrets, cookies, JWT and Authorization are masked by default". An `HttpOnly` session cookie is the one value page scripts cannot read; `cookies` copies it into the agent transcript.

### B-04 Attach guidance contradicts itself; doctor's only advice is a fresh, logged-out profile

One question, "how do I attach to the user's browser?", four answers:

- SKILL.md:22: "From Chrome 136, the **default** profile cannot enable CDP (`--remote-debugging-port` is ignored). Use a persistent non-default daily dir always launched with remote debugging, or an isolated spawn."
- references/commands.md:113: "**Do NOT suggest `--remote-debugging-port`** restarts or separate `--user-data-dir` profiles. The correct prerequisite is `chrome://inspect/#remote-debugging` toggle only."
- references/commands.md:99 (WSL): "Ask the user to open Chrome and enable remote debugging at `chrome://inspect/#remote-debugging`."
- references/troubleshooting.md:39: "Prefer `--daily-profile` over `chrome://inspect/#remote-debugging` as the first human step." The runtime refuses `--daily-profile` on Chromium 136+ (`tests/issue-366-daily-existing-session.test.mjs:97`).

Doctor, by function call with every probe refused (`checkCdpReachability`, then `formatDoctorReport`; no browser contacted):

```text
CDP: no DevToolsActivePort and no CDP_PORT set; nothing answered on 127.0.0.1:9222, 9224
Next: cdp spawn-debug-browser edge --port 9222 --user-data-dir '<LOCALAPPDATA>\chrome-cdp-ex\daily-edge' (ask first)
```

The check object also carries `hint: "Daily Chrome attach failed on 9222. … Or set CDP_PORT=<port> for an Electron app"`, but `formatDoctorReport` prints only the Node, CDP, Profile and Next lines (`cdp:26244-26259`). The text an agent reads never mentions `CDP_PORT`, the only way to reach Electron or a browser started with its own `--user-data-dir` and port.

On this host the default Chrome profile is attachable in inspect-toggle mode (`%LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort` names port 3048), so SKILL.md:22's "cannot enable CDP" does not hold for Chrome 154. The toggle is the only route in these documents that keeps the user's current logged-in session.

Consequence: an agent that follows SKILL.md or doctor's Next moves the user into a profile with no logins, against "do not replace the logged-in session with a clean browser by default".

### B-05 Error `Kind` follows the page's wording, and one failure type gets different Kinds

| Command | Error line | Kind | Next |
|---|---|---|---|
| `eval <t> "throw new Error('Field is required')"` | `Field is required` | usage | `cdp help eval` |
| `eval <t> "throw new Error('Save failed')"` | `Save failed` | unknown | `cdp status <t>` |
| `nav <t> http://no-such-host.invalid/` | `net::ERR_NAME_NOT_RESOLVED` | unknown | `cdp perceive <t> -C -d 8` |
| `text <t> "#does-not-exist"` | `text: no element matched …` | unknown | `cdp status <t>` |
| `click <t> "#does-not-exist"` | `Element not found …` | selector | `cdp perceive <t> -C -d 8` |
| `scroll <t> bottom` | `Direction required: …` | unknown | `cdp perceive <t> -C -d 8` |
| `perceive <t> --frame @f3` | `Unknown frame: @f3. Run "frame" …` | unknown | `cdp status <t>` |

Some failures print a five-line `Recovery:` block before `Next:` (`eval`, `text`, typo), others only `Kind:` and `Next:` (`click`, `nav`).

Cause: CLI errors are classified by substrings of the error text, including text the page produced; any error containing "required" becomes `usage` (`buildCliErrorRecovery`, `cdp:31447`, branch `cdp:31936-31943`). Action failures go through a second classifier with its own vocabulary (`classifyActionFailureKind`, `ar:466`). No schema enumerates the Kinds (A-07).

Consequence: a page's own validation message sends the agent to `help eval`, and failures of one kind route to different next steps.

### B-06 `Next:` lines do not run when copied

- Every CLI error's Next ends with ` (Kind: <kind>)` (`cdp:32196-32206`; also `scripts/lib/session-policy.mjs:629`). Doctor and consent-gated Next lines end with ` (ask first)` (`cdp:26250`, `cdp:32198`).
  - bash: `echo cdp perceive 5DE36628 -C -d 8 (Kind: unknown)` → `syntax error near unexpected token '('`, exit 2.
  - PowerShell: the same line → "The term 'Kind:' is not recognized as the name of a cmdlet …" (localized on the test host).
- The command word is `cdp`. The installed entry point is `bin/chrome-cdp` (package.json `bin`); SKILL.md:36 calls `cdp` a shorthand. Nothing named `cdp` is on PATH after install.
- Typo recovery: `clik <t> @1` → `Next: cdp click` (no target, no ref).
- Missing target: `perceive` with no target → `Run: cdp list  # if empty: cdp open https://example.com` plus `Then: cdp open https://example.com`, with five tabs open.

The suffix exists so that `| tail -1` still shows the Kind (#533). AGENTS.md's product goals require executable next steps (AGENTS.md:23-25).

Consequence: an agent that pastes the Next line verbatim gets a shell error on every failure path.

### B-07 Iframe content is invisible on the default observe path; cross-site iframes are missing entirely

`/iframe-host.html`: an outer button, a same-origin iframe and a cross-site iframe (`http://localhost:41801/inner.html`), each with a "Card holder" input and a "Pay now" button.

```text
perceive <t>        → Interactive: 1 button   (tree: Outer button @1 and three headings; no iframe node, no frame count)
perceive <t> -C     → the same tree; [Visible controls] lists only Outer button
frame <t>           → Frames: 2   @f1 top, @f2 same-origin          (the cross-site frame is not listed)
click <t> "text=Pay now" → Error: Named control not found: "Pay now" (from text=Pay now). No button or link has that exact visible text or aria-label …
                           Kind: selector   Next: cdp perceive <t> -C -d 8
perceive <t> --frame @f2 → [textbox] Card holder @f2:1, [button] Pay now @f2:2; fill + click work ("Paid by Ann Same")
```

Cause: `perceive` walks the top frame's AX tree and neither renders iframe nodes nor counts frames (`cdp:15690-15691`); targets are not auto-attached to out-of-process frames (no `Target.setAutoAttach`; `cdp:13231-13237`), so `frame` cannot list them. Misses point back to `perceive -C -d 8`, which shows the same tree.

Consequence: the agent concludes the payment form does not exist. The same-origin frame is reachable only for an agent that already knows `frame` → `perceive --frame` (references/commands.md:467; not in SKILL.md). The cross-site frame has no ref path at all.

### B-08 Effects that land outside the top document are reported as failures, and Next repeats the action

(a) Cross-site iframe, coordinates taken from the iframe's `getBoundingClientRect()`:

```text
clickxy <t> 231 461   → Error: click: Input.dispatchMouseEvent completed but the page received no mousedown/click events at (231, 461).
                        The mouse path failed closed. Try jsclick or click --js.   Kind: no-input-events   Next: cdp jsclick <t> 231,461   (exit 1)
type <t> "Ann Cross"  → Typed 9 characters … Outcome: no-change … Verdict: investigate
clickxy <t> 93 504    → the same no-input-events error   (exit 1)
shot <t>              → the cross-site frame shows "Ann Cross" in the input and "Paid by Ann Cross"
```

Both clicks worked. Corrected on 2026-10-09 (proposals phase): the Next line does not click "Pay now" again. `jsclick` takes no coordinates, so `jsclick <t> 141,81` fails with `Named control not found: "141,81"`, `Kind: selector`. A live check on a cross-site "Pay now" frame recorded one payment for the first `clickxy`, reported as failed, and none for its Next. The second payment comes from an agent that retries a click the receipt calls failed.

(b) Download link, `/download.html` (`<a href="/report.csv" download>`):

```text
click <t> "#dl" → Error: Click on <A href="http://127.0.0.1:41801/report.csv"> did not navigate. Try jsclick or click --js.
                  Kind: no-navigation   Next: cdp jsclick <t> "#dl"   (exit 1)
```

The file was saved anyway, to `%USERPROFILE%\Downloads\report.csv` (19 B, written at the click; removed from there after the test). `click <t> "#dl" --expect-download --out DIR` reports the same click correctly (`Downloaded "report.csv" 19 B sha256=…`).

(c) `window.open` from a button, `/download.html`:

```text
click <t> "#popup" → Error: click: the control did not react (Outcome: no-change). Clicked <BUTTON> "Open in new window"
                     Kind: click-no-change   (exit 1)
list               → a new tab "Inner  http://127.0.0.1:41801/inner.html?frame=popup"
```

Cause: the input-event check listens in the top document only (`cdp:16840`); the no-navigation check treats a download as a failed navigation (`cdp:17289`); the no-change verdict (`cdp:10354`) does not look at new targets or downloads unless the agent passed `--expect-download` or the element is a `target=_blank` link.

Consequence: the receipt says "failed" for an action that happened. For the download, the Next line repeats it (a second download); for the frame click and the popup, an agent that retries the "failed" click pays twice or opens a second window.

### B-09 `scroll down` does not move a nested scroll container but reports success; `--scroll-container` is silently dropped

`/scroll-shell.html`: fixed header; `<main>` with `overflow:auto` holds 200 rows; the document does not scroll.

```text
perceive <t>                                → Scroll: 0/6147 (0%)
scroll <t> down                             → Scrolled by (0, 500). Position: (0, 0). Next: cdp perceive <t> -C -d 8   (exit 0)   main.scrollTop 0
scroll <t> down --scroll-container "#main"  → Scrolled by (0, 500). Position: (0, 0).   (exit 0)   main.scrollTop 0
scroll <t> bottom                           → Error: Direction required: down, up, left, right, x,y, or to top/to bottom   Kind: unknown
scroll <t> to bottom                        → Scrolled to bottom. #main scrollTop: 6147 / 6147 max (at-bottom: yes)
```

`--format json` for `scroll down`: `dispatch.ok: true`, `expectedOutcome: "leftover-ax-scroll-no-change"`. `help scroll` lists `[--scroll-container SELECTOR]` for every form.

Cause: directional scroll calls `window.scrollBy` and reports `window.scrollX/Y` (`cdp:18583-18596`), while `perceive` measures the nested scroller. The capability passes `args[1]` as the pixel amount (`cdp:28766`), so `--scroll-container` is parsed as an amount (500 by default) and `#main` as an ignored extra; the guard at `cdp:18580` never sees the flag. Only `to top|bottom` finds nested scrollers (`cdp:18567-18579`). With an explicit amount the guard does fire, as Phase D's Haiku run in scenario 7 met it: `scroll <t> down 6400 --scroll-container #viewport` → `Error: scroll: --scroll-container is only valid with to top/to bottom`, `Kind: unknown`; the help line lists the flag for every form.

Consequence: list and admin-shell pages cannot be paged by direction, and the agent is told it scrolled.

### B-10 `click "<two-word label>"` is parsed as CSS; `text=` works but JS-clicks through a cover

`/overlay.html`: a "Save profile" button under a fixed consent banner with an "Accept all" button.

```text
click <t> "Save profile"       → Error: Element not found: Save profile (waited 2001ms for attach). No element matches this CSS selector;
                                 pass the control's visible text or an @ref from perceive.   Kind: selector
click <t> "Accept all"         → the same, after 2000 ms
click <t> "Accept"             → … "Accept" was read as a CSS tag selector; for a button or link with that visible text use "text=Accept" …
click <t> "text=Save profile"  → JS-clicked <BUTTON> "Save profile".   (exit 0; the button was under the banner)
click <t> @1  /  "#save"       → Error: click point (97, 322) … is covered by position:fixed <DIV#consent> … The mouse click was not sent   Kind: covered
```

With the banner removed, `click <t> "Save profile"` still fails the same way, while `click <t> "儲存設定"` (a button added with that label) JS-clicks it.

Cause: `isLikelyCssSelector` reads `<word> <word>` as a descendant selector (`cdp:17321-17333`), so "Save profile", "Sign in" and "Add to cart" are CSS, while labels that start with a non-ASCII letter take the named path. The miss message for a multi-word input asks for the visible text the agent just passed (`cdp:17365-17372`). Named clicks run `namedInViewportJsClickStr` (`cdp:17510-17533`): a JS click with no hit test, so the covered-click refusal does not apply. SKILL.md never mentions `text=`.

Consequence: the most natural call after reading `[button] Save profile @1` waits 2 s, fails, and is told to do what it just did. The working form bypasses the cover check.

### B-11 `perceive --since-action` renumbers every ref but prints only added and removed lines

`/refs.html`: three buttons; an `eval` before the first `perceive` makes "Invite Cy" insert "Remove everyone" at the top 300 ms after its click.

```text
perceive <t>                 → Invite Ann @1, Invite Bob @2, Invite Cy @3
click <t> @3                 → Clicked <BUTTON> "Invite Cy" (@3). Next: cdp perceive <t> --since-action
perceive <t> --since-action  → +++ Added (1):  + [button] Remove everyone  @1
                               ~~~ Text nodes updated (1 added)
click <t> @2                 → Clicked <BUTTON> "Invite Ann" (@2)   (exit 0)
```

The since-action view, which every receipt points to, reassigned all refs (Ann 1→2, Bob 2→3, Cy 3→4) and showed none of the moves. The `@2` the agent last saw as "Invite Bob" clicked "Invite Ann". Without the intermediate perceive, refs stay bound to their nodes (O-07).

Cause: the since-action path re-runs ref assignment for the whole page (`markPerceived`, `cdp:15941-15952`; branch `cdp:15954-15959`) and prints `formatPerceiveDiffOutput` for added and removed nodes only. #548 fixed the same silent renumbering for `fill`.

Consequence: after any page update, the next `click @N` can hit a different control and exit 0.

### B-12 MCP: the recovery path is closed, unlisted tools answer, and failures are 50 times the CLI's size

stdio MCP server against the same browser, `/overlay.html` (`docs/audit/mcp-probe.mjs`):

| Call | Result |
|---|---|
| `tools/list` | 14 tools, 10,999 B |
| `click {selector:"#save", confirm:true}` (covered) | `isError`, 15,761 B: a pretty-printed JSON receipt as text (8,277 chars) plus `structuredContent` (6,454 chars). The CLI prints 313 chars for the same failure. |
| its next steps | `cdp click … --js`, `cdp overlay …`, `cdp perceive … --since-action`: CLI strings, not tool calls |
| `run_command {command:"status"}` | JSON-RPC error `run_command command not allowlisted: status` |
| `run_command jsclick`, `run_command eval` | the same refusal |
| `report {target}` (not in `tools/list`) | answers: 27,220 B, the same 12,747-char report as text and as `structuredContent` |
| `perceive {target}` | 3,719 B: text 1,915 + `structuredContent` 1,432 |
| `screenshot {target}` | text 245 chars (the path) + an image block of 13,268 base64 chars |

Cause: the `run_command` allowlist (`cs:940-942`) and refusal (`mcp:111-118`); `tools/call` resolves any catalog tool, listed or not (`cs:1027-1032`); results carry both a text and a structured view (`mcp:671-684`); MCP mutations return JSON receipts (`mcp:334-371`).

Consequence: an MCP agent cannot run the Next it is given (`status`, `jsclick`, `overlay`, `console`, `netlog`, `dialog`, `frame`, `report`; A-03), cannot discover the tools that would answer, and reads about 3,900 tokens (chars/4) per refused click.

### B-17 `dismiss-modal` presses an accept button and reports "Dismissed"

Found while checking proposal 3's premise ([proposals.md](proposals.md)); reproduced live on 2026-10-09 with the scenario harness (disposable headless Chrome 154, loopback app). The page shows a "Delete project?" dialog (`role=dialog`, `aria-modal=true`) over a backdrop; the accept button deletes through `POST /delete`.

```text
[OK, delete it] [Cancel]   dismiss-modal <t> → Dismissed modal via close button "ok" (div)   (exit 0)   server: POST /delete
[確認] [取消]               dismiss-modal <t> → Dismissed modal via close button "確認" (div) (exit 0)   server: POST /delete
```

Cause: `findCloseButton` in `dismissModalScript` (`cdp:27589-27604` at `21e96b5`) takes the first visible control, in DOM order, whose `aria-label` contains, or whose text equals or contains, any of `close`, `dismiss`, `cancel`, `ok`, `關閉`, `取消`, `確認`, `繼續`, `×`, `✕`. "OK, delete it" contains `ok`, 確認 is "confirm", 繼續 is "continue", and any label with the letters "ok" ("Book now") matches.

Consequence: `dismiss-modal` is the Next of a click covered by a dialog (`ar:292`), of the `overlay` failure kind (`ar:565`) and of the `overlay` command (`cdp:27587`, `cdp:27629` at `acd4312`). An agent that follows those Next lines confirms the dialog it meant to close, and the receipt says "Dismissed".

## BUG

### B-13 `open` waits 1.5 s for a URL that cannot appear

A wall-clock trace of `open http://127.0.0.1:41801/todo.html` (`node --import ./scripts/probe-cli-preamble.mjs`) shows the daemon answering at about 450 ms, then 13 rounds of "new browser WebSocket → `Target.getTargets` → close → sleep 100 ms" from 587 to 2,210 ms, then navigation. `open --format json` reports `navigation.method: "Page.navigate"`, the fallback.

Cause: `createOpenTarget` always creates `about:blank` (`cdp:32347-32351`). `navigateOpenTarget` first polls up to 1,500 ms for the target's URL to equal the requested URL (`cdp:32459-32462`, `waitForOpenTargetUrl` `cdp:32417-32446`). Nothing navigates before that poll ends, so it always runs out.

Cost: `open` took 2.2–2.3 s on local fixtures and 2.7–3.9 s on public pages; a cold daemon start is about 0.5 s ([token-perf.md](token-perf.md)). Every task starts with `open`.

### B-14 `npm test` fails when `issue-366` runs before `issue-358`

```text
npx vitest run tests/issue-366-daily-existing-session.test.mjs tests/issue-358-first-step.test.mjs \
  --no-file-parallelism --sequence.shuffle.files --sequence.seed=<N>
seeds 1, 2, 4, 5, 6: issue-358 first → 14 passed
seed 3:              issue-366 first → 2 failed
  Error: 9222 occupant (/tmp/chrome-cdp-ex-edge-debug-profile-9222) is not the daily profile. …
```

The two failures match the Phase A baseline (`npm test`, default workers).

Cause: `issue-366 › still allows isolated non-default user-data-dir spawn` (`tests/issue-366-daily-existing-session.test.mjs:219-248`) calls `spawnDebugBrowserStr` without a `rememberEndpoint` stub. It writes `cdp-last-endpoint.json` (port 9222, that profile) into the one runtime directory `vitest.config.js:11-17` creates per run. The two issue-358 tests (`tests/issue-358-first-step.test.mjs:47-69`, `104-126`) call `checkCdpReachability` and `getWsUrl` without `lastEndpoint`, read the record, and in test mode trust it (`cdp:2493-2498`). CI's `--maxWorkers=2` schedule happens to run them in the passing order.

The tests never contact a real browser: in test mode the occupant lookup does not open a WebSocket (`cdp:2493-2498`).

B-15 and B-16 were found while building the Phase C scenarios ([scenarios.md](scenarios.md)); their repros use the scenario harness (`scripts/lib/agent-scenario-harness.mjs`).

### B-15 `netlog` keeps `Cache-Control: no-store` responses pending, at 0B, with no body

A page fetched six URLs from a local server that answers `{"error":"upstream timeout",…}`, varying method, status and `Cache-Control: no-store`:

```text
netlog <t>
  #1 GET  /api/x?nostore=0             → 200 (11ms, 225B)
  #2 GET  /api/x?nostore=1             → 200 (8ms, 0B)
  #3 POST /api/x?nostore=0             → 200 (4ms, 225B)
  #4 POST /api/x?nostore=1             → 200 (5ms, 0B)
  #5 POST /api/x?nostore=0&status=503  → 503 (6ms, 253B)
  #6 POST /api/x?nostore=1&status=503  → 503 (4ms, 0B)
netlog <t> --id 1|3|5 --body    → Body (51–62 bytes): {"error":"upstream timeout",…}
netlog <t> --id 2|4|6 --body    → Body: not available (still loading: No data found for resource with given identifier)
netlog <t> --id 2 --format json → "state": "pending"   (#1: "state": "complete")
```

Cause, corrected on 2026-10-09 (proposals phase). Phase C compared the daemon with a direct page WebSocket and blamed the daemon, but the two runs also differed in whether the page read the body: the daemon run's page did `.then(r => r.status)`, the direct run's page `.then(r => r.text())`. A controlled 2 × 2 run (no-store or not × body read or not, each request watched by a raw page WebSocket and by the daemon) separates them:

| Response | Page reads the body | Raw page WebSocket | Tab daemon (`netlog`) |
|---|---|---|---|
| cacheable | no | `loadingFinished`, body readable | complete, body readable |
| `no-store` | no | `dataReceived` only, no `loadingFinished`; `getResponseBody`: "No data found" | pending, 0B, "still loading" |
| cacheable | yes | `loadingFinished`, body readable | complete, body readable |
| `no-store` | yes | `loadingFinished`, body readable | complete, body readable |

Chrome itself sends no `loadingFinished` for a `no-store` response that the page never reads, and keeps no copy for `getResponseBody`; the daemon reports what Chrome sends. `Network.streamResourceContent({ requestId })` still returns the bytes Chrome received (`bufferedData`), and can be called more than once. What the tool got wrong is the label: "still loading" and "0B" for a response that has arrived, and no attempt to read the received bytes. Proposal 1 ([proposals.md](proposals.md)) reads them and labels the body `not read by the page`.

Consequence: authenticated APIs commonly send `no-store`, and a page that checks `response.ok` and throws never reads the body, so on network-failure tasks the error body (scenario 11's "upstream timeout") was unreadable, and "still loading" invites re-querying a request that has finished.

### B-16 `text` joins table cells, `<dt>`/`<dd>` pairs and grid cells without a separator

```text
                        cdp text                                             innerText
<dl id="detail">        Part numberBP-4471-CPrice$64.90In stock37            Part number\nBP-4471-C\nPrice\n$64.90\nIn stock\n37
<tr id="row-1042">      #1042Ann LeeConference hotel, 2 nightsNT$ 9,800Pending  #1042\tAnn Lee\tConference hotel, 2 nights\tNT$ 9,800\tPending
CSS-grid row            SHP-00183AdatumIn transit2026-10-14                  SHP-00183\nAdatum\nIn transit\n2026-10-14
```

Cause: `textPageScript` walks the DOM itself and adds a newline only after a fixed list of tag names (`cdp:22328`); `TD`, `TH`, `DT`, `DD` and the children of grid or flex rows are not on it, and the walker ignores the computed `display`.

Consequence: values run into labels and neighbours ("AdatumIn transit"); reading a field out of a table, detail panel or grid, the usual last step of a task, needs guessing.

## THIN

- **T-01** `text` has no size cap. `text <t> "#big"` on `/cjk.html` returned 458,890 bytes (4,000 lines) with no truncation note (`cdp:22409-22415`; A-11).
- **T-02** `perceive` shows five rows per table (`TABLE_ROW_LIMIT = 5`, `cdp:15036`, `cdp:15159-15168`). On the Hacker News front page the header says `Interactive: 229 a, 1 input[text]`, the tree lists stories 1–2, then `[note] ... more rows truncated` with no command named to see the rest. HN lays out with tables, so stories 3–30 have no ref.
- **T-03** The golden path reads a page with `perceive`, which costs 2.5–11 times `text --auto` on the public content pages measured (GitHub 23,620 vs 9,368 chars; Wikipedia 71,566 vs 19,316; MDN 30,632 vs 2,784). `open` recommends `text --auto` first (`recommendation.run` in `open --format json`); SKILL.md's step 2 says `perceive`.
- **T-04** `dialog` auto-accepts by default. `click <t> "#del"` on `confirm('Delete item?')` → `Dialog: confirm "Delete item?" → accepted`, and the item is deleted. The receipt's second line says so. Playwright's default is to dismiss.
- **T-05** Tabs from `open` are background tabs (`document.visibilityState: "hidden"`), so page timers fire at most once a second: a button enabled by `setTimeout(…, 1500)` became enabled at about 2.7 s, after the 2 s CSS wait gave up (`Kind: disabled`, Next `waitfor <t> '#buy:not(:disabled):not([aria-disabled="true"])'`). The same click by `@ref` does not wait, and its Next is `perceive -C -d 8`.
- **T-06** After a daemon crash, the restart line says "netlog buffer was reset" but not that the console and exception buffers are empty. A `console.error` logged before the crash is gone (`console --all` → "Console buffer is empty"). #606 covers netlog.
- **T-07** A click whose fetch fails (500, 404, offline) prints `Clicked … Next: cdp netlog <t>` and exits 0; the failing request is one more call away. `netlog`'s and `diff-shot`'s Next lines print the 32-character target id (`Next: cdp netlog 5DE3662823292C3AD35C7B472146763B --id 12`), unlike the rest (#559, #601).
- **T-08** SPA detail view: after "Open Beta", `perceive --since-action` lists the new heading and button but shows the new paragraph ("Price: 20") only as `~~~ Text nodes updated (1 added)`.
- **T-09** Receipt shapes differ by command: a successful `click` is one line (79 chars), `upload` and `type` are 22-line blocks with an AX diff (A-12).
- **T-10** `dismiss-modal` on an `aria-modal` session prompt with "Stay signed in" and "Sign out" and no close button: "No close button found in 1 dialog(s); sent Escape as fallback", "Outcome: no-change", exit 0, and the modal stays; Next is `overlay <t> --format json`. It did not press "Sign out" (scenario 3). Fixed together with B-17 by proposal 3: the command now exits 1 with `Kind: dialog-open` and names the dialog's buttons.
- **T-11** `list` marks one tab with `*`. It is a score-based recommendation (`cdp:4963`, `rankPageTargets`) whose ties are broken by target id, not the active tab, and nothing in the output says so. With two "Feature flags · Acme" tabs (staging, production) the `*` fell on either one across runs (scenario 5).

## OK

- **O-01** Open shadow roots: `perceive` assigns refs inside (`[textbox] Display name @1`, `[button] Save preferences @2`); `fill @1` + `click @2` → "Saved Ann". CSS `#name` does not pierce the root, as expected.
- **O-02** UTF-8 over daemon IPC: `text` of 4,000 CJK-and-emoji lines (458,890 B) and `eval` of the same text (462,889 B) arrived intact: no U+FFFD, 4,000 of 4,000 lines. Both ends buffer bytes and decode whole frames (`cdp:1197-1221`, `scripts/lib/daemon-transport.mjs:300-421`).
- **O-03** Daemon crash: after `taskkill /F` of a tab daemon, the next command restarted it in about 0.5 s, printed `daemon restarted: dialog=accept, throttle=off, 0 mocks restored, netlog buffer was reset`, and refused old refs with `Kind: stale-ref` and the reason.
- **O-04** Concurrent cold start: four `eval` calls on a tab without a daemon all exited 0; one daemon process remained.
- **O-05** Covered-click refusal by `@ref` or CSS names the cover and sends no event (`Kind: covered`). Its Next (`click … --js`) is #601.
- **O-06** `diff-shot` at 1252×799 takes 0.31 s per call, and a `PerformanceObserver('longtask')` in the page recorded no task of 50 ms or more across baseline and compare. A-22 is withdrawn.
- **O-07** Refs stay bound to nodes until the next perceive: after a button was inserted above `@1`, `click @1` still clicked "Invite Ann".
- **O-08** `netlog --id` masks `Authorization`, `Cookie` and URL tokens; `report` masks console URLs and tokens (B-03 table).
- **O-09** `click … --expect-download --out DIR` saves the file and reports name, size and sha256.
- **O-10** SPA without a URL change: `click` + `perceive --since-action` shows the detail view replacing the catalog.
- **O-11** `flow "fill …; press Enter"` submits the form; `flow` has no batch lookahead.
- **O-12** Warm tab switching: `eval` alternating between two tabs with running daemons has the same median as staying on one tab ([token-perf.md](token-perf.md)).
- **O-13** Same-origin frames: `frame` → `perceive --frame @f2` → `fill @f2:1`, `click @f2:2` work ("Paid by Ann Same").
- **O-14** `alert` and `confirm` during `click` do not hang the daemon: the call returns in under 1 s with the dialog on the receipt.
- **O-15** No test contacts a real browser: in test mode the occupant lookup reads the endpoint record and never opens a WebSocket (`cdp:2493-2498`), so `npm test` on this host did not reach the Edge on 9222.

## Cross-cutting causes

Inputs to proposals.md; each needs the measurement and contract analysis that phase asks for.

1. **One observation scope.** The click verifier, `perceive` and directional `scroll` observe the top document of one target. Out-of-process frames, new targets, downloads and nested scrollers fall outside it: B-07, B-08, B-09, T-08.
2. **Two classifiers, string-built Next lines.** Kinds come from substrings in two places, and Next lines are assembled as display strings with suffixes: B-05, B-06, B-12.
3. **Redaction at some builders instead of at output.** B-03.
4. **Benchmark-shaped guesses in the action core.** The huggingface listing path and the CSS-or-text guess decide what an input means: B-01, B-10.
5. **Refs are per-snapshot ordinals.** Any perceive renumbers: B-11.

## Phase A items, after reproduction

| A | Now | Change |
|---|---|---|
| A-01 | B-01 | worse: `batch` fill + Enter fails on every non-huggingface page |
| A-02 | B-02 | `upload` has the same defect |
| A-03, A-06, A-12 | B-12 | measured payloads |
| A-04 | B-03 | `checkpoint` header too, while claiming `default-redacted` |
| A-05 | B-04 | doctor's text drops the `CDP_PORT` hint |
| A-07 | B-05 | reproduced live |
| A-09 | B-06 | the suffix breaks both bash and PowerShell |
| A-11 | T-01 | 458,890 bytes in one call |
| A-19 | B-07 | the cross-site frame is also missing from `frame` |
| A-20 | B-09 | `--scroll-container` is swallowed as the amount |
| A-22 | O-06 | withdrawn |
| A-24 | B-14 | root cause: a shared endpoint record, not worker count |

Not reproduced here: hidden-window capture on a headed daily browser (only headless was used), the WSL2 bridge, an Electron app, and the native file chooser that a click on a file input opens in a headed browser (headless returned `click-no-change`).
