# Changelog

## [Unreleased]

### Open issue dogfood (#320)

* Leftover golden-path `perceive -C -d 8` then `scroll` still treats unchanged
  identities as honest `Outcome: no-change`. Already-at-bottom leftover-ax-scroll
  receipts whose Next is already `perceive -C -d 8` no longer reprint
  `scroll: dispatched via scroll` / `Target: down`. `Scrolled by … Position: …`
  already states the action and the honest no-move. `Outcome: no-change`,
  Verdict `continue`, Settle ms, and Next `-C -d 8` stay. A Visible-control
  cap-swap stays `Outcome: changed` with compact unique named samples and still
  prints dispatched/Target, its body, and Page / Viewport. Leftover `--cards`
  / `pdf-viewer.v1` / generic non-leftover actions keep their own
  dispatched/Target. Interactive census / `Console: clean` / Coords clickxy
  tutorial stay dropped on the action receipt; no Recovery hint that restates
  Next, no settle-shape Outcome reason, no reprinted Page / Viewport on honest
  no-change, no tautological AX body on honest no-change, no Hint
  `--since-action`, no generic Recovery hint on leftover changed, no
  `+++ Added` signed-commit / `time` GMT selector dump, no relative-time /
  GMT named samples, shared commit title not on both sample sides, `#297`
  compact headline, `#295` rect-chrome no-change, `#293` leftover N>0
  `--cards`, leftover `-C -d 8` then mutating `click --js`, `#285` PDF
  Next, and `#286`/`#291` hover honest-gate hold.
  `HOVER_MOUSE_ACK_TIMEOUT_MS` stays 250.

### Open issue dogfood (#318)

* Leftover golden-path `perceive -C -d 8` then `scroll` still treats unchanged
  identities as honest `Outcome: no-change`. Already-at-bottom leftover-ax-scroll
  receipts whose Next is already `perceive -C -d 8` no longer reprint
  `(no changes detected in AX tree)`. `Outcome: no-change` already states that.
  `Position:` on the action line stays. Verdict `continue`, Settle ms, and Next
  `-C -d 8` stay. A Visible-control cap-swap stays `Outcome: changed` with
  compact unique named samples and still prints its body and Page / Viewport.
  Standalone leftover `perceive -C -d 8` dumps still print that no-change line.
  Leftover `--cards` / `pdf-viewer.v1` / generic non-leftover actions keep their
  own AX body. Interactive census / `Console: clean` / Coords clickxy tutorial
  stay dropped on the action receipt; no Recovery hint that restates Next, no
  settle-shape Outcome reason, no reprinted Page / Viewport on honest no-change,
  no Hint `--since-action`, no generic Recovery hint on leftover changed, no
  `+++ Added` signed-commit / `time` GMT selector dump, no relative-time /
  GMT named samples, shared commit title not on both sample sides, `#297`
  compact headline, `#295` rect-chrome no-change, `#293` leftover N>0
  `--cards`, leftover `-C -d 8` then mutating `click --js`, `#285` PDF
  Next, and `#286`/`#291` hover honest-gate hold.
  `HOVER_MOUSE_ACK_TIMEOUT_MS` stays 250.

### Open issue dogfood (#316)

* Leftover golden-path `perceive -C -d 8` then `scroll` still treats unchanged
  identities as honest `Outcome: no-change`. Already-at-bottom leftover-ax-scroll
  receipts whose Next is already `perceive -C -d 8` no longer reprint the
  `Page:` / `Viewport:` identity header (`Focused: none` included).
  `Position:` on the action line already states scroll identity, and Next
  `perceive -C -d 8` re-establishes page identity. Verdict `continue`,
  `(no changes detected in AX tree)`, and Next `-C -d 8` stay. A
  Visible-control cap-swap stays `Outcome: changed` with compact unique
  named samples and still prints Page / Viewport. Standalone leftover
  `perceive -C -d 8` dumps still print those header lines. Leftover
  `--cards` / `pdf-viewer.v1` / generic non-leftover actions keep their
  own Page / Viewport headers. Interactive census / `Console: clean` /
  Coords clickxy tutorial stay dropped on the action receipt; no Recovery
  hint that restates Next, no settle-shape Outcome reason, no Hint
  `--since-action`, no generic Recovery hint on leftover changed, no
  `+++ Added` signed-commit / `time` GMT selector dump, no relative-time /
  GMT named samples, shared commit title not on both sample sides, `#297`
  compact headline, `#295` rect-chrome no-change, `#293` leftover N>0
  `--cards`, leftover `-C -d 8` then mutating `click --js`, `#285` PDF
  Next, and `#286`/`#291` hover honest-gate hold.
  `HOVER_MOUSE_ACK_TIMEOUT_MS` stays 250.

### Open issue dogfood (#313)

* Leftover golden-path `perceive -C -d 8` then `scroll` still treats unchanged
  identities as honest `Outcome: no-change`. Already-at-bottom leftover-ax-scroll
  receipts whose Next is already `perceive -C -d 8` print `Outcome: no-change`
  without the settle-shape reason `Settle shape was leftover golden-path AX;
  viewport rect chrome did not replace identities.` The body already says
  `(no changes detected in AX tree)`. Verdict `continue` and Next `-C -d 8`
  stay. A Visible-control cap-swap stays `Outcome: changed` with compact unique
  named samples. Generic non-leftover actions still print an Outcome reason.
  Leftover `--cards` / `pdf-viewer.v1` no-change still print their settle-shape
  Outcome reasons. Interactive census / `Console: clean` / Coords clickxy
  tutorial stay dropped on the action receipt; the leftover `perceive -C -d 8`
  dump itself still prints those header lines. No Recovery hint that restates
  Next, no Hint `--since-action`, no generic Recovery hint on leftover
  changed, no `+++ Added` signed-commit / `time` GMT selector dump, no
  relative-time / GMT named samples, shared commit title not on both sample
  sides, `#297` compact headline, `#295` rect-chrome no-change, `#293`
  leftover N>0 `--cards`, leftover `-C -d 8` then mutating `click --js`,
  `#285` PDF Next, and `#286`/`#291` hover honest-gate hold.
  `HOVER_MOUSE_ACK_TIMEOUT_MS` stays 250.

### Open issue dogfood (#311)

* Leftover golden-path `perceive -C -d 8` then `scroll` still treats unchanged
  identities as honest `Outcome: no-change`. Already-at-bottom leftover-ax-scroll
  receipts whose Next is already `perceive -C -d 8` no longer reprint
  `Recovery hint: AX identities unchanged; re-run perceive -C -d 8 instead of
  report.` Outcome, Verdict `continue`, and Next already carry that handoff.
  A Visible-control cap-swap stays `Outcome: changed` with compact unique named
  samples. Generic non-leftover actions still print a Recovery hint when Next
  is report / investigate. Interactive census / `Console: clean` / Coords
  clickxy tutorial stay dropped on the action receipt; the leftover
  `perceive -C -d 8` dump itself still prints those header lines. Named
  samples, no Hint `--since-action`, no generic Recovery hint on leftover
  changed, no `+++ Added` signed-commit / `time` GMT selector dump, no
  relative-time / GMT named samples, shared commit title not on both sample
  sides, `#297` compact headline, `#295` rect-chrome no-change, `#293`
  leftover N>0 `--cards`, leftover `-C -d 8` then mutating `click --js`,
  `#285` PDF Next, and `#286`/`#291` hover honest-gate hold.
  `HOVER_MOUSE_ACK_TIMEOUT_MS` stays 250.

### Open issue dogfood (#309)

* Leftover golden-path `perceive -C -d 8` then `scroll` still treats a
  Visible-control cap-swap as `Outcome: changed`. Honest leftover-ax-scroll
  receipts whose Next is already `perceive -C -d 8` no longer reprint
  Interactive census / `Console: clean` / Coords clickxy tutorial chrome,
  and no longer reprint Outcome / Receipt / Verdict as the same
  "Observed page change after action" sentence three times. The leftover
  `perceive -C -d 8` dump itself still prints those header lines. A new
  file, heading, or link still prints a structural diff. Named samples,
  no Hint `--since-action`, no generic Recovery hint, no `+++ Added`
  signed-commit / `time` GMT selector dump, no relative-time / GMT named
  samples, shared commit title not on both sample sides, `#297` compact
  headline, `#295` rect-chrome no-change, `#293` leftover N>0 `--cards`,
  leftover `-C -d 8` then mutating `click --js`, `#285` PDF Next, and
  `#286`/`#291` hover honest-gate hold. `HOVER_MOUSE_ACK_TIMEOUT_MS`
  stays 250.

### Open issue dogfood (#307)

* Leftover golden-path `perceive -C -d 8` then `scroll` still treats a
  Visible-control cap-swap as `Outcome: changed`. A name that appears on
  both sides of the swap (live: a shared commit title
  `Add diffusers weights (modular pipeline) (#2)`) stays in headline
  membership but does not occupy a named sample slot on both sides, so
  unique file / heading / link names fill the cap. Counts stay honest.
  A new file, heading, or link still prints a structural diff. Named
  samples, no Hint `--since-action`, no generic Recovery hint, no
  `+++ Added` signed-commit / `time` GMT selector dump, no relative-time
  / GMT named samples, `#297` compact headline, `#295` rect-chrome
  no-change, `#293` leftover N>0 `--cards`, leftover `-C -d 8` then
  mutating `click --js`, `#285` PDF Next, and `#286`/`#291` hover
  honest-gate hold. `HOVER_MOUSE_ACK_TIMEOUT_MS` stays 250.

### Open issue dogfood (#305)

* Leftover golden-path `perceive -C -d 8` then `scroll` still treats a
  Visible-control cap-swap as `Outcome: changed`. Relative-time / GMT
  title strings in the live formatter shape (`a role=link "2 days ago"` /
  `time "Thu, 13 Aug 2026 15:18:27 GMT" [clickable]`) stay in headline
  membership but do not occupy the named 4-sample cap, so the remaining
  useful name fills the cap. Counts stay honest. A new file, heading, or
  link still prints a structural diff. Named samples, no Hint
  `--since-action`, no generic Recovery hint, no `+++ Added` signed-commit
  / `time` GMT selector dump, `#297` compact headline, `#295` rect-chrome
  no-change, `#293` leftover N>0 `--cards`, leftover `-C -d 8` then
  mutating `click --js`, `#285` PDF Next, and `#286`/`#291` hover
  honest-gate hold. `HOVER_MOUSE_ACK_TIMEOUT_MS` stays 250.

### Open issue dogfood (#303)

* Leftover golden-path `perceive -C -d 8` then `scroll` still treats a
  Visible-control cap-swap as `Outcome: changed`. Title-only Visible-control
  dump lines in the live formatter shape (`span "…" span[title="…"] .classes`
  / `time "Fri, … GMT" time[title="…"] .classes`) are identity chrome, not a
  structural `+++ Added` selector dump. A new file, heading, or link still
  prints a structural diff. Named samples, no Hint `--since-action`, no
  generic Recovery hint, `#297` compact headline, `#295` rect-chrome
  no-change, `#293` leftover N>0 `--cards`, leftover `-C -d 8` then mutating
  `click --js`, `#285` PDF Next, and `#286`/`#291` hover honest-gate hold.
  `HOVER_MOUSE_ACK_TIMEOUT_MS` stays 250.

### Open issue dogfood (#301)

* Leftover golden-path `perceive -C -d 8` then `scroll` still treats a
  Visible-control cap-swap as `Outcome: changed`. Honest leftover-ax-scroll
  `changed` receipts no longer print the generic
  `Recovery hint: Continue from the observed action evidence.` Outcome,
  compact named samples, Verdict `continue`, and Next `perceive -C -d 8`
  already carry that handoff. Generic non-leftover `changed` actions still
  print the hint. Named samples, no Hint `--since-action`, `#297` compact
  headline, `#295` rect-chrome no-change, `#293` leftover N>0 `--cards`,
  leftover `-C -d 8` then mutating `click --js`, `#285` PDF Next, and
  `#286`/`#291` hover honest-gate hold. `HOVER_MOUSE_ACK_TIMEOUT_MS`
  stays 250.

### Open issue dogfood (#299)

* Leftover golden-path `perceive -C -d 8` then `scroll` still treats a
  Visible-control cap-swap as `Outcome: changed`. Samples now prefer
  accessible names. Live collector fallbacks (`img "img"` /
  `a role=link "link"`) stay in headline membership but do not occupy
  the 4-sample cap. Leftover-ax-scroll receipts print Next
  `perceive -C -d 8` without Hint `--since-action`. A new file,
  heading, or link still prints a structural diff. `#297` compact
  headline, `#295` rect-chrome no-change, `#293` leftover N>0 `--cards`,
  leftover `-C -d 8` then mutating `click --js`, `#285` PDF Next, and
  `#286`/`#291` hover honest-gate hold. `HOVER_MOUSE_ACK_TIMEOUT_MS`
  stays 250.

### Open issue dogfood (#297)

* Leftover golden-path `perceive -C -d 8` then `scroll` still treats a
  Visible-control cap-swap as `Outcome: changed` (membership, not rect
  chrome). The settle receipt now summarizes that swap instead of reprinting
  8+8 / 9+9 full control lines, and a fold-tag-only change on the same
  `[navigation] Main` identity is not a Removed+Added pair. A new file,
  heading, or link still prints a structural diff. Next stays
  `perceive -C -d 8` on this leftover scroll, including the honest cap-swap
  `changed` case, instead of a Hint-only handoff or `report` /
  `record-actions`. `#295` rect-chrome no-change, `#293` leftover N>0
  `--cards`, leftover `-C -d 8` then mutating `click --js`, `#285` PDF
  Next, and `#286`/`#291` hover honest-gate hold. `HOVER_MOUSE_ACK_TIMEOUT_MS`
  stays 250.

### Open issue dogfood (#295)

* Leftover golden-path `perceive -C -d 8` is the settle shape for the next
  `scroll`. Viewport `@ref` / Visible-control rect chrome (`(x,y w×h)`) is
  not a page mutation: unchanged AX identities stay `Outcome: no-change` /
  continue with Next `perceive -C -d 8` instead of `report` /
  `record-actions`. A new file, heading, or link entering the leftover tree
  is still `Outcome: changed`. `#293` leftover N>0 `--cards` then scroll
  stays compact `cards.v1`. Leftover `-C -d 8` then mutating `click --js`
  still reports live text. `#285` leftover PDF `click --js` and `#286`/`#291`
  hover honest-gate hold.

### Open issue dogfood (#293)

* Leftover `perceive --cards` / `--role feed` with a real feed window (N>0
  cards) is the settle shape for the next `scroll`. Recapture stays
  `cards.v1` so timestamp chrome is not a fake AX `Outcome: changed`, and
  an unchanged virtualized window is `no-change` / continue with Next
  `perceive --cards` instead of `report` or `perceive -C -d 8`. Card
  identity ignores relative-time chrome in article AX names (`· 2m`),
  including when the clock lives in the article `name` itself rather than
  only child StaticText. A third article entering the leftover window is
  still `Outcome: changed` even when `expectedOutcome` is
  `cards-window-no-change`. 0-card leftovers still
  recapture default AX (`#257` / `#279`). Leftover feed `--cards` then
  `click --js` still recaptures AX. `#285` leftover PDF `click --js` and
  `#286`/`#291` hover honest-gate hold.

### Open issue dogfood (#291)

* `hover` still snapshots settle-shape AX before mouseMoved and recaptures
  immediately. Sync hover that already shows a delta KEEPs that baseline.
  Idle recapture now discards without sitting `waitForHoverDomChange` /
  `HOVER_MUTATION_TIMEOUT_MS` (3000). Chrome 151 mouseenter can land after
  that window; discard already keeps a later no-op `scroll` at `(0, 0)` as
  `Outcome: no-change`. Hover stays a one-liner. `HOVER_MOUSE_ACK_TIMEOUT_MS`
  stays 250. `#286` honest gate and `#285` leftover PDF `click --js` hold.

### Open issue dogfood (#282)

* Leftover `perceive` on a Chrome PDF plugin (`chrome-cdp-ex.pdf-viewer.v1`)
  is not a valid AX settle shape. No-op `press Escape` / Arrow* stay
  `Outcome: no-change` / `Verdict: continue` instead of claiming
  "Observed page change after action" from the same empty-AX stub.
  Identical stub vs stub is not evidence of a plugin page turn.
  `#257` leftover-cards + Escape and `#279` leftover-cards + mutating
  `click --js` are unchanged.

### Open issue dogfood (#279)

* Leftover 0-card `perceive --cards` / `--role feed` dumps are not a valid
  settle shape for a mutating click. Action settle recaptures a default AX
  baseline so `click --js` that changes live text reports `Outcome: changed`,
  not `no-change` / "No visible AX tree change" while the handler ran.
  `#257` leftover-cards + Escape stays expected no-change.

### Open issue dogfood (#270, #271, #272)

* Password-like `fill` / `type` values are redacted in every `record-actions`
  field, including `target.dispatchText` and effect samples. `commandArgs`
  stay `<redacted>` and the step stays `replayable: false`.
* `cascade` `winner` / `editTarget` is the declaration that produces
  `computedValue`. An injected `!important` rule beats a non-important inline
  style instead of naming the losing inline as the edit target.
* `replay` of an incomplete `fill` (`needsInput: ["text"]` or no text
  argument) skips or fails closed with missing field `text`. It does not
  guess `""` or mutate the live input. Password fills that are
  `replayable: false` stay skipped.

### Open issue dogfood (#266, #267)

* Realistic `click` / `clickxy` overlap Chrome 151's mouse CDP acks instead of
  serializing on a 250ms compositor-ack swallow, then fail closed when a
  capture-phase probe on the **target document** sees no `mousedown`/`click`
  events — including when the probe cannot be installed. Framed `@fN:M` clicks
  probe the iframe document (or ignore a top-level empty `seen`) so #261 does
  not fail-close a working iframe handler. JSON receipts go through
  `runActionWithFeedback`; CLI `Kind: no-input-events` Next is
  `cdp jsclick <prefix> <sel>`. `jsclick` / `click --js` still run
  `HTMLElement.click()` as a separate command.
* `restore` of a `checkpoint --unsafe-full` artifact writes the captured cookie
  values. It no longer re-redacts them to the literal sentinel `<redacted>`.
  Default redacted checkpoints still skip cookie restore.

### Open issue dogfood (#259)

* Leftover `perceive --frame @fN` dumps are not reused as top-level action
  settle-diffs. After a same-origin iframe dump, top-level `fill` / `select` /
  `upload` / `click` settle the page AX tree and report `Outcome: changed` when
  the control actually changed, instead of `no-change` / overlay against the
  leftover iframe. Frame-local `@fN:M` actions still settle inside that frame.
  `#257` leftover `--cards` reset is unchanged.

### Open issue dogfood (#255, #256, #257)

* Leftover `perceive --cards`, `perceive -s`, and default `perceive --format json` on a
  Chrome PDF plugin emit `chrome-cdp-ex.pdf-viewer.v1` with Next
  `cdp eval <prefix> "document.contentType"`. They no longer dump empty cards,
  an untitled empty tree, or Next:`click @ref`. Default perceive / `--qa` /
  `--summary` stay pdf-viewer.v1.
* `fullshot` on a Chrome PDF plugin fail-fasts as `pdf-viewer.v1` instead of hanging
  ~30s, exiting 0 with a captureScreenshot-timeout "saved" fallback, and poisoning
  later `shot` / `elshot` on that tab. Viewport-sized HTML `fullshot` stays the
  #252 fast path.
* `perceive --cards` dumps are not reused as action settle-diffs. After a 0-card
  page, no-op `press Escape` / dead `clickxy` / unfocused `type` stay
  `Outcome: no-change` and do not recommend `--cards`. Real-feed `--cards` still
  returns `cards.v1`. Default perceive then Escape stays no-change.

### Open issue dogfood (#250, #251, #252, #253)

* `perceive --qa` / `perceive --summary` and `summary` on a Chrome PDF plugin emit
  `chrome-cdp-ex.pdf-viewer.v1` instead of untitled/indeterminate QA or a fake HTML
  census. Next is `cdp eval <prefix> "document.contentType"`, never `report` /
  `perceive` / `text` or literal `<target>`. HTML QA summary stay pass/populated.
* `cascade` on a Chrome PDF plugin uses the same PDF gate as `styles` / `html` /
  `snap`: `pdf-viewer.v1`, no embedder BODY computed styles. HTML cascade,
  including the #231 winning-rule `[overridden]` marker, is unchanged.
* `fullshot` of a viewport-sized page uses the working viewport capture path
  instead of `captureBeyondViewport` + clip. A full-page clip timeout fail-closes
  without claiming `Page.captureScreenshot` is unavailable and without skipping
  later `shot` / `elshot` viewport captures. `#223` `diff-shot` stays fail-closed.
* Realistic `click` bounds mouse compositor-ack like `hover` so press/release stay
  a click, not a multi-second stall. example.com Learn more navigates again;
  `click --js` / `jsclick` still work. A true no-nav still fail-closes.

### Open issue dogfood (#245, #246, #247, #248)

* `visual-check` / `responsive-audit` on a Chrome PDF plugin emit `chrome-cdp-ex.pdf-viewer.v1`
  immediately instead of waiting through screenshot timeouts. Next is
  `cdp eval <prefix> "document.contentType"`, not `shot` / `perceive`. Screenshot
  timeout paths restore the previous viewport and exit non-zero.
* `snap` / `snap --full` on a Chrome PDF plugin emit `pdf-viewer.v1` instead of an
  empty AX tree plus a perceive hint.
* `styles` on a Chrome PDF plugin emit `pdf-viewer.v1` instead of dumping the
  chrome-extension embedder BODY/HTML computed styles. Selector misses interpolate
  the target prefix instead of literal `<target>`.
* `fill` re-reads the live control after typing. If `.value` / textContent stay
  empty (controlled textarea), it retries the native setter, then fails closed:
  no `Filled` line, `Action failure: fill-no-change`, not `Outcome: changed`.

### Open issue dogfood (#241, #242, #243)

* `qa` on a Chrome PDF plugin emits `chrome-cdp-ex.pdf-viewer.v1` instead of
  `Verdict: pass` / Next:`perceive`. Next is `cdp eval <prefix> "document.contentType"`.
* `html` / `html --auto` on a Chrome PDF plugin emit `pdf-viewer.v1` and do not
  return the empty chrome-extension embedder shell as successful HTML. Selector
  misses interpolate the target prefix instead of literal `<target>`.
* `cookiedel` of a dotted-domain cookie (`domain=.example.com`) deletes with the
  cookie's domain/path (not URL-only) and re-reads the jar. If the cookie remains,
  the command exits non-zero and does not print `Cookie deleted`.

### Open issue dogfood (#237, #238, #239)

* `responsive-audit` / `visual-check` restore the tab's original viewport after the
  last `--viewport`, including when a screenshot times out (same contract as #210 / `qa`).
* `click --qa` on a Chrome PDF plugin emits `chrome-cdp-ex.pdf-viewer.v1` instead of
  QA pass / populated / changed. Next is `cdp eval <prefix> "document.contentType"`.
* PDF-plugin action receipts (`click`, `viewport`, selector misses) interpolate the
  target prefix in that eval Next. Misses no longer recommend `perceive`.

### Open issue dogfood (#234, #235)

* `click --qa` compact Page/URL and JSON `summary.page` use the post-navigation
  identity (same as the action receipt / `pageHealth.evidence`), not the pre-nav
  snapshot. A Learn more click that lands on iana.org no longer labels example.com.
* `report --qa` and `report` on a Chrome PDF plugin emit `chrome-cdp-ex.pdf-viewer.v1`
  and Next:`cdp eval <prefix> "document.contentType"`, matching `perceive` /
  `text --auto`. They no longer claim pass/populated or recommend perceive/click @ref.

### #217 residual after #218

* `hover` bounds `Input.dispatchMouseEvent` (`mouseMoved`) renderer-ack to 250ms
  and treats that timeout as success. Live Chrome 151 withholds the ack for ~5s
  on a static page; the event is already forwarded, so hover must not wait it out.

### Open issue dogfood (#210, #211, #212, #213, #214, #215, #216, #217)

* `qa` restores the tab's original viewport after desktop/mobile emulation,
  including when a screenshot times out.
* First no-baseline no-op `press` is `Outcome: no-change` / continue, not a
  tree dump labeled `changed`.
* Missing `select` option, non-select target, and missing selector are
  `Kind: usage` / `cdp help select` (no `ReferenceError: value is not defined`).
* `upload` of a missing path fails closed and does not plant a 0-byte ghost file.
* Invalid/zero `wait` duration is `Kind: usage` / `cdp help wait`, not doctor or status.
* Unknown `tab-group` name is `Kind: usage` / `cdp tab-group list`, not doctor.
* `cookiedel` of a missing cookie exits non-zero and does not claim deletion.
* `hover @ref` reads the current rect without the click scroll-settle loop.

### #183 / #190 residuals after #193

* `target --url … --exact` with zero matches classifies as `target-resolution`
  and recovers with `cdp list`, not unknown/doctor. Ambiguous matches stay on
  the existing `pages matched` path.
* Non-document GitHub 404s (issue `agent_tasks`, hovercards, and the same class
  of UI chrome) are not blocking `network-failure` when the document itself is
  not a 404. Compact nav size is unchanged.

### Open issue dogfood (#181–#191)

* Resolve `use --name` aliases case-insensitively, strip `@`, and match stored
  target prefixes against live pages. Missing aliases recover with `cdp list`
  instead of doctor.
* `list` / `open` JSON next-steps prefer `text --auto` / `--cards` over starring
  a tab and dumping `perceive -C -d 8`.
* Target no-match / ambiguous prefix / unknown flags recover with list or
  `cdp help <command>`, not doctor/status.
* `click @ref` bounds `Runtime.callFunctionOn` to 2s with a no-scroll fallback;
  `--js` works after the selector; unknown click flags fail closed.
* `report --qa` reads live page title/url; text `--compact` omits evidence;
  default JSON is compact (`--all` for the large dump).
* Chrome PDF viewer pages return an honest receipt instead of empty untitled
  perceive / unknown text errors.
* `help [command]` prints a topic; `stop` sends protocol `args: []` and exits
  non-zero on failure; `blur` no longer suggests `back`.
* Installed skills ship `bin/chrome-cdp`; same `packageVersion` ignores
  scriptPath-only daemon mismatches.
* `nav` defaults to compact page observation (`--perceive` opt-in) and ignores
  Copilot `agent-sessions` 404s as blocking network failures.
* `perceive --cards` after scroll reports unchanged when the card window did
  not replace; waitForEvent fails fast on websocket close.

### Compact feed perception

* Add `perceive --cards` (alias `--role feed`) for virtualized timelines. Returns
  bounded `chrome-cdp-ex.cards.v1` cards with ref/url/handle/truncated text and
  optional engagement crumbs, default cap 12 (`--last N` up to 20), and a
  virtualization notice when fewer articles are in the AX tree than the
  viewport height suggests (#156).

### Open onboarding

* Default `open` no longer dumps a full perceive (11–29 KB). It returns
  `Opened new tab: PREFIX url` plus `Next: cdp perceive PREFIX -C -d 8`.
  Pass `--perceive` to opt into the previous AX dump. Attach waiting is
  fail-fast (5s). The "Allow debugging?" banner is delayed until about 1s
  or the third failed daemon-socket connect so normal daemon boot does not
  look like a permission prompt. Use `--attach-timeout-ms 60000` when
  permission may still be pending; `--attach-timeout-ms 0` still returns the
  target handoff without waiting. Catalog `feedbackPolicy` is `report-only`
  to match the compact default (#160).

### Table collection

* Replace the unbounded `table` claim with bounded observation, completeness,
  explicit `--collect` virtual collection, and private `--continue` tokens.
  Observation previews at most 20 inline rows and 8,192/16,384 UTF-8 bytes.
  Collection requires an explicit scroll container, stable identity, and MCP
  `confirm: true`; standalone `loadall` does not preserve recycled rows (#151).

### Setup

* `setup.mjs --for hermes --write` copies the skill into
  `~/.hermes/skills/chrome-cdp-ex` (or `$HERMES_HOME/skills`). Print-only
  `--for hermes` now prints the resolved destination instead of
  `<hermes-skills-dir>`. `doctor` treats Hermes, Claude, and Codex skill
  paths as first-class installs (#154).

### Agent reliability

* When multiple tabs are open, doctor Proven / next probe is `cdp list` rather than a starred or first-daemon perceive. Leftover golden-path examples use `<target-from-list>` (sample after list), not the starred tab. Skip-links (`href #`, Skip to, 跳至, keyboard / 鍵盤快速鍵), including zh-TW skip *buttons* whose accessible name / `aria-label` matches `跳至`, get late `@refs`; article/feed/listitem/status nodes get `@1` (#163).
* Focused search/combobox typeahead listboxes are omitted from default perceive; use Escape, `-s main`, or `--keep-typeahead`. Scroll reports the largest overflow scrollport, not only `documentElement` (#164).
* Dead CDP now fails fast with a same-profile relaunch receipt. `list` / `doctor` / `attach` no longer wait on a WebSocket fallback after connection refused or HTTP timeout. Remembered existing Chrome profiles relaunch with `--remote-debugging-port` and `--user-data-dir` (no disposable `rm -rf`). When `CDP_PORT` is set and the profile is unknown, doctor prefers `chrome://inspect` over a blank `spawn-debug-browser` even on Linux/no DISPLAY. Profile discovery uses reviewed `Browser.getBrowserCommandLine` (#155).
* Default `fill --format json` to a compact `chrome-cdp-ex.fill.v1` receipt
  (`value`, `changed`, `navigation`, `typeahead`) instead of the full action
  envelope. Pass `--full` / `--unsafe-full` for `chrome-cdp-ex.action.v1`.
  `perceive --since-action` after a no-navigation typeahead fill summarizes as
  `textbox value set; N suggestion links`, including when the header is
  `Focused: <input>` rather than an AX `textbox` / `searchbox` / `combobox`.
  Bare `--since-action` reuses the last perceive snapshot shape (so
  `perceive -i` then fill does not reroot against a full tree) and keeps
  typeahead so the one-liner actually prints (#162).
* `perceive -x` no longer empties Mintlify-style `<main>` wrappers. Help documents
  `text --auto` and `-x`; SKILL.md and `recipes.md` add a "Read this page"
  path using `text --auto`, `eval`, and `call` (#161).
* Reject unknown `perceive` flags with compact-flag help and a non-zero exit
  instead of silently dumping the full page (#158).
* Pending CDP requests now fail on socket close / `Inspector.detached` instead of
  aging into `Timeout: Page.navigate`. A navigation load waiter is cancelled when
  `Page.navigate` throws (#144).
* Doctor no longer blocks a live CDP session just because PATH `node` is v20.
  It discovers Hermes / fnm / nvm Node 22 binaries, prints the exact rerun
  command, and `bin/chrome-cdp` re-execs that binary (#157).
* Preserve ambiguous completion when a side-effect-capable daemon request loses
  its response. CLI remains non-zero and MCP remains `isError: true`, while the
  error now reports `completion: "unknown"`, `sideEffectMayHaveOccurred: true`,
  `retrySafe: false`, bounded transport diagnostics, and a verify-before-retry
  perception command. The client never redispatches the action (#150).
* Preserve failed JSON Action Results while returning a non-zero CLI status and
  MCP `isError: true` when `dispatch.ok` is false. Nested replay/repeat steps now
  fail fast on the same semantic result; dispatched `no-change`, `attention`,
  and post-dispatch observation timeouts retain their existing transport-success
  semantics (#143).

## [2.15.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.14.0...v2.15.0) (2026-08-12)

v2.15.0 turns the post-v2.14 work into a claim-honest Codex and cross-host
release and a contract-first Runtime v3 release candidate. It adds one
disposable-fixture Codex route, a versioned six-host evidence manifest, a
60-second demo, compact action output, stronger target diagnostics, and release
gates that validate the actual attached tarball. Internally, public contracts,
local evidence, shared application execution, supervised per-tab runtimes,
direct MCP routing, single-owner command metadata, generated surfaces, and
exact-method CDP domains now replace duplicated authority without removing the
81-command compatibility surface.

### Runtime v3 contracts and routing

* Freeze all 81 canonical commands, 23 aliases, public schemas, representative
  CLI behavior, MCP mappings, and exact package inventory in versioned v2.15
  fixtures.
* Add a bounded local Validation Lab with explicit risk budgets, source-bound
  mode-0600 evidence, replay, redaction, fingerprints, failure classification,
  duplicate detection, and regression promotion. Live proofs use only
  disposable Chrome for Testing and loopback fixtures.
* Route `perceive`, `click`, `report`, and governed `evalraw` through the shared
  application contract behind a complete immutable 81-command dispatcher;
  `html`, `text`, `table`, `net`/`network`, `status`, `summary`, `snap`/`snapshot`,
  `controls`, `frame`/`frames`, `overlay`/`overlays`, `styles`, `components`,
  `record-actions`/`recordactions`, `export-playwright`/`export-pw`, `wait`,
  `waitfor`, `cascade`, `checkpoint`, and `cookies` now use explicit read
  capabilities. Six reviewed action cohorts now also route through explicit
  application capabilities, through `cookieset`, `cookiedel`, `dialog`,
  `keepalive`, and `netlog`. Raw-script `eval`, `eval64`, and `call` now pass
  through the same authorization and application-dispatch boundary while
  remaining MCP-inaccessible. Conditional observation controls `console` and
  `record` now share the same application boundary while preserving their
  clear/action confirmation rules. Recursive workflows `batch`, `flow`,
  `repeat`, and `replay` now re-enter that same dispatcher for every nested
  step. External-input mutations `upload`, `inject`, and `restore` now use the
  same confirmation, Action Receipt, and privacy boundary; checkpoint JSON,
  paths, and injected content are redacted from action evidence. Screenshot
  capture commands `shot`/`screenshot`, `diff-shot`/`diffshot`, `elshot`,
  `fullshot`, and `scanshot` now use the same application boundary while
  preserving 0600 artifact writes and explicit-path confirmation. QA filesystem
  commands `qa`/`qa-page` and `responsive-audit`/`visual-check` now use that
  boundary too, require MCP confirmation before viewport/file effects, and keep
  every screenshot private and task-contained. All 68 target commands now use
  the catalog-derived application dispatcher; the 13 targetless commands remain
  explicit CLI adapters and only five daemon protocol groups remain outside the
  application surface. Add immutable public browser resources, private
  handles, a shared-key BrowserSupervisor with bounded stale recovery, extracted
  daemon transport, and direct in-process MCP routing with no CLI subprocess
  fallback.
* Make one dependency-free catalog the owner of command policy, aliases, help,
  domains, MCP tools/resources, and the escape-hatch allowlist. Generate bounded
  README/reference indexes from that owner while keeping explanatory prose
  hand-authored.
* Route all reviewed normal CDP calls through exact-method domain clients. Raw
  CDP remains a separately authorized gateway whose audit records method and
  side-effect class only, never params or results.
* Tighten MCP confirmation from catalog policy: mutating/session-state forms,
  composite/raw/script commands, sensitive reads, clear/reset operations,
  long-running controls, QA filesystem commands, and explicit screenshot output paths fail closed
  unless confirmed. Read-only forms such as exact tab-group list/show and
  default screenshot output remain unconfirmed.

### Codex and cross-host evidence

* Add a reproducible Codex Killer Path covering disposable installation, doctor, perception, one safe mutation, Action Receipt, `perceive --since-action`, and report handoff.
* Add a versioned host-validation manifest and checker for Claude Code, Codex,
  Cursor, OpenClaw, Hermes, and Pi. Only the Codex CLI-skill route is marked
  `live-validated`, bound to the exact historical Phase 1 candidate identity
  after all seven capability checks passed. The manifest explicitly marks that
  evidence as not current-tree proof.
* Add a safe 60-second Codex demo, poster, and machine-readable evidence boundary. The fixture uses no personal tabs, cookies, credentials, or authenticated browser state.
* Add source-bound Runtime v3 validation on disposable Chrome for Testing and
  loopback pages. The current-tree proof covers 69 live commands, 56 direct-MCP
  extraction parities, supervisor stale-target recovery, five typed-domain/raw
  denials, and nine fail-closed application/signal injections with complete
  cleanup.

### Agent output and target evidence

* Emit compact action JSON as a single line and omit non-actionable populated-page health noise so agent handoffs consume less output without losing failure evidence.
* Collapse stable compact target-binding diagnostics while preserving requested, bound, resolved, source, status, and rebound details whenever target identity is ambiguous or changes.

### Release and documentation

* Ship the host checker, manifest, Codex Killer Path, demo media, plugin manifest, CLI shim, setup script, skill contract, CLI/MCP runtimes, and direct runtime libraries in the official tarball.
* Add an executable release-package checker that inspects the actual tarball for
  44 release-critical entries and verifies the exact 70-entry inventory plus
  every repository-relative README link; the release workflow runs tests, lint,
  docs, host validation, public contracts, and this artifact check before
  calculating the checksum and attaching the package.
* Redesign the README first screen around already-open browser access, six host routes, a clickable Codex demo, a direct Killer Path, the Playwright boundary, and explicit separation of local-fixture proof, ecosystem recognition, and adoption.

### Validation hardening

* Reject invalid calendar dates, empty or absolute evidence paths, repository escapes including symlink escapes, missing files, and directories in the host manifest without crashing.
* Package-content tests exercise the real npm tarball and a deliberately incomplete tarball instead of inferring release completeness from repository paths.
* Bind release-campaign artifacts to the package version and a deterministic SHA-256 identity of the runtime/benchmark candidate. Public proof promotion now rejects truncated rounds, failures, incomplete gates, wrong route/profile inventories, missing identity, and source-digest drift.

### Security and compatibility

* The shipped runtime remains zero-dependency, and `npm audit --omit=dev` reports zero production vulnerabilities. The development toolchain currently reports three high-severity transitive findings through Vitest/coverage/ESLint (`brace-expansion`, `postcss`, and `nanoid`); they do not ship as runtime dependencies and remain tracked release risk.
* No CLI commands, aliases, public JSON schemas, Action Receipt fields, or
  supported host setup routes are removed. MCP confirmation is intentionally
  stricter for catalog-classified mutation, sensitive, raw/script, composite,
  clear/reset, long-running, and explicit-output-path forms; callers should pass
  `confirm: true` for those operations. The per-tab daemon remains the owner of
  tab-scoped state behind the new supervisor/application boundaries.

## [2.14.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.13.2...v2.14.0) (2026-07-25)

v2.14.0 makes chrome-cdp-ex installable and usable across agent hosts without forking the runtime. Compared with v2.13.2, a single `setup.mjs` bootstrap plus INTEGRATIONS docs cover Claude Code, Codex, Cursor, OpenClaw, Hermes, and Pi; the always-loaded skill is slim with on-demand references; MCP gains curated Tier-1 workflow tools, an allowlisted `run_command` escape hatch, and resources; and release tarballs finally include the Claude plugin manifest, setup script, and `bin/chrome-cdp` shim.

### Cross-host distribution

* Add `scripts/setup.mjs` (`--detect`, `--for <host>`, `--verify`) plus `INTEGRATIONS.md` and `docs/integrations/` for Claude Code, Codex, Cursor, OpenClaw, Hermes, and Pi (#133).
* Ship `bin/chrome-cdp` PATH shim and include `.claude-plugin/`, `INTEGRATIONS.md`, `bin/`, and `scripts/setup.mjs` in the release tarball; the release workflow packs and attaches the validated asset on Node 22 (#133).
* Split the always-loaded skill: slim `SKILL.md` with on-demand `references/{commands,recipes,troubleshooting}.md` and thin `hosts/*` overlays (#133).

### MCP

* Expand curated MCP tools with Tier-1 workflow coverage (`navigate`, `press`, `wait_for`, `cascade`, `components`, `spawn_debug_browser`, `record_snapshot`, `session_checkpoint`) plus allowlisted `run_command` (#133).
* Advertise MCP resources / templates for doctor status and per-session report/screenshot reads (#133).
* Harden the MCP escape hatch: omit composite `batch`/`flow`/`repeat`/`replay` from the allowlist, and require `confirm: true` for `--unsafe-full` / sensitive exports (#133, #134).

### Doctor / contracts

* `doctor --format json` includes `routeRecommendation` for host-aware CLI vs MCP defaults (#133).
* Publish starter JSON Schemas under `docs/schemas/` for action receipts, doctor, and route recommendation (#133).

### Compatibility

No CLI commands were removed. Existing Claude Code / Codex skill copy paths still work. Agents that previously loaded the full mega-`SKILL.md` now get the golden path by default and should open `references/commands.md` for exhaustive flags. MCP clients gain new tools; mutating tools and sensitive `run_command` calls still require `confirm: true`. Release consumers must use the v2.14.0+ tarball if they need `setup.mjs`, the plugin manifest, or `bin/chrome-cdp` inside the packed asset.

## [2.13.2](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.13.1...v2.13.2) (2026-07-24)

v2.13.2 hardens live-agent recovery against common misfires and Chrome remote-debugging edge cases. Compared with v2.13.1, near-miss commands stop dumping full help, invalid Playwright selectors and overflow-clipped controls fail closed with clearer next steps, daemon freshness follows the installed script instead of the agent cwd, and websocket-only CDP endpoints plus sleeping tabs recover more reliably.

### Agent Command Recovery

* Unknown near-miss commands such as `resize`, `tabs`, and `key` dumped the full help catalog and burned context. Unknown commands now return a short Did-you-mean recovery, and the common aliases `resize`→`viewport`, `tabs`/`ls`→`list`, and `key`→`press` are registered (#126, #129).
* Playwright-style `:has-text()` selectors failed `querySelector` and surfaced as opaque `Action failure: unknown`. They are now classified as `invalid-selector` with CSS / `data-testid` / `@ref` recovery instead of inventing unsupported `click --text` (#127).

### Perception And Hit Testing

* Interactive inventory could list controls that were fully clipped inside an overflow scrollport, so agents clicked coordinates that hit a different visible control. Overflow-scrollport-clipped controls are omitted from the default interactive / cursor inventory (#128).

### Daemon Identity And CDP Compatibility

* Invoking the skill script by absolute path after `cd` into another chrome-cdp-ex checkout could false-positive `Stale daemon` because freshness used `process.cwd()` git HEAD when the skill tree lacked a nearby `package.json`. Freshness now follows `realpath(script)` package identity and no longer treats cwd git as a competing identity (#130).
* Chrome 136+ / SSH websocket-only setups that 404 `/json/version` and `/json/list`, plus sleeping background tabs, could block attach or discovery. Discovery falls back to `/devtools/browser` and `Target.getTargets` when HTTP discovery returns 404, and daemon attach wakes the tab with `Target.activateTarget` (#125). Connection failures still keep the clear `Cannot reach CDP` error; the websocket fallback is limited to HTTP 404.

### Compatibility

No commands were removed. Existing `press`, `viewport`, and `list` callers are unchanged. Consumers that scraped full help text from unknown-command failures should use the Did-you-mean recovery / `cdp help <cmd>` instead. Daemon freshness mismatches that previously appeared after changing cwd into another checkout should stop once both sides run v2.13.2+.

## [2.13.1](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.13.0...v2.13.1) (2026-07-20)

v2.13.1 makes readiness and daemon cleanup trustworthy for direct-checkout workflows. Compared with v2.13.0, a usable checkout is no longer rejected solely because it is outside the conventional Claude skill directory, and successful cleanup no longer exits without saying what happened.

### Readiness

* In v2.13.0, `doctor --format json` set `ready: false` whenever any advisory existed, including a missing `~/.claude/skills/chrome-cdp-ex` install path, even when CDP, tabs, and browser permission were working. In v2.13.1, install location remains visible as an advisory while `ready` and the new explicit `operationalReady` field stay true when there are no failures or actionable warnings (#122).
* Genuine operational warnings still keep readiness false, so this change does not turn low file-descriptor limits, unstable CDP, or other actionable findings into a green result.

### Lifecycle Confirmation

* In v2.13.0, `stop <target>` could stop a daemon successfully with exit code 0 but empty stdout. In v2.13.1, `stop` always returns a confirmation: text mode identifies stopped or failed targets and remaining sessions, while `--format json` returns `chrome-cdp-ex.stop.v1` with `stopped`, `stoppedTargets`, `failedTargets`, `remainingSessions`, `remainingTargets`, and `noop` (#123).
* Repeating `stop` after cleanup now returns an explicit no-op receipt instead of another silent success.

### Compatibility

No commands were removed and stop exit-code behavior is unchanged. Consumers of doctor JSON should treat `ready` / `operationalReady` as the operational gate and retain `status`, `readiness`, and per-check `severity` for advisory display. Scripts that previously expected empty stdout from `stop` should ignore the new receipt or request and parse `--format json`.

## [2.13.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.12.0...v2.13.0) (2026-07-16)

v2.13.0 focuses on trustworthy browser evidence during long-running agent sessions. Compared with v2.12.0, visual audits, screenshots, page-health checks, recovery guidance, and target attachment now agree on what the live browser is actually showing.

### What Changed

* Responsive audits could miss controls clipped inside nested containers or materially occluded by visible fixed, sticky, or dialog surfaces, while intentional scrolling could create noise. Audits now use bounded geometry and visible hit-tested occlusion evidence and suppress intentional scrolling, so operators get more actionable findings without a claim of detecting every overlap (#115).

### Reliability

* Screenshot capture could return a contradictory black frame without distinguishing it from a legitimately dark page. Capture now retries once through an alternate surface only when a near-black frame contradicts a computed light page, then fails closed if the result remains unreliable, so operators do not treat suspect visual evidence as proof (#117).
* Action, perception, QA, and responsive checks could disagree about page health, including marking a visibly populated page blank when a URL sample was missing. They now share multi-signal page-health evidence and report loading states as indeterminate, so successful actions and populated pages are not rejected by a single missing signal (#118).

### Diagnostics And Handoffs

* Session reports could keep recommending recovery for an older failure after a newer action had been verified successful. Reports now clear stale guidance while retaining recovery for the latest unresolved failure, so handoffs reflect the current session state (#116).
* Target commands could trust stale daemon bindings before checking live tabs, leaving operators attached to the wrong browser target with little identity evidence. Commands now resolve live tabs first, detect daemon-to-tab mismatches, rebind once, and expose requested, bound, resolved, source, and status diagnostics, so target attachment is both safer and auditable (#119).

### Compatibility

Upgrading from v2.12.0 removes no commands and requires no configuration migration. Existing structured outputs only gain or clarify diagnostics, so current workflows can upgrade without command or configuration changes.

## [2.12.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.11.0...v2.12.0) (2026-07-12)

### Features

* add console baselines with strict option validation, bounded repeat stop conditions, and flow selector/text assertions (#108, #109).

### Fixes

* reject occupied debug-browser ports before launch, return inferred final expressions from multi-statement async eval, and settle smooth scrolling before pointer dispatch (#105, #106, #107).
* propagate halted flows and fail-fast repeats as command failures, and reject DOM/network wait timeouts instead of reporting false success (#110, #111).

## [2.11.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.10.0...v2.11.0) (2026-07-10)

### Features

* add matched `benchmark:cli` and MCP/CLI route comparisons using the same task id and six semantic checkpoints.
* make dashboard, docs, auth, table, and canvas real-app profiles distinct, with generated/exercised probe coverage and a real canvas fixture.
* default MCP perception to adaptive output and MCP controls/reports to compact handoffs.
* add bounded multi-tab broadcast result/error previews, complete retry commands, and explicit `--full-results` output.

### Fixes

* preserve `eval --raw` through CLI argument normalization.
* resolve component targets correctly for strict `@ref` handles and arbitrary CSS selectors.
* recursively redact and bound React/Vue component trees and props/state by default, with explicit `--unsafe-full` and `--max-chars` controls.
* make failed, incomplete, or regression-fail live campaigns exit nonzero unless `--allow-failures` is explicit.
* keep CLI benchmark fixture servers responsive by replacing blocking child execution with asynchronous processes.
* isolate `open` readiness probes from persistent tab daemons and return first action evidence before secondary frame/CSS diagnostics.

### Security And Maintenance

* update Vitest/coverage and transitive Vite, PostCSS, esbuild, and brace-expansion dependencies until `npm audit` reports zero vulnerabilities.
* add docs contracts for contributor paths, architecture claims, shipped-feature status, release tags, and tarball names.

### Documentation

* refresh README, reference, skill, contributor guidance, design status, self-improvement loop, GitHub Pages proof, install commands, release links, and benchmark claims for v2.11.0.

## [2.10.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.9.1...v2.10.0) (2026-07-10)

### Features

* add `tab-group` / `broadcast` multi-tab coordination (#97).
* add `components` MVP for React/Vue tree and element props/state (#98).
* add adaptive perceive text-row budgets via `--adaptive` / `--last auto` (#99).
* document Browser Use mapping for Action Receipt and recovery (#100).
* research awesome-list outreach targets without auto-submitting external PRs (#101).
* add `emulate` for dark/light and reduced-motion media features (#93).
* add `eval --raw` for compact object output without pretty JSON (#94).
* centralize action recovery policies in a data-driven registry (#95).
* improve multi-tab target selection with `target --url/--title`, list ranking heuristics, and `open --reuse-url` (#82).
* return spawn-debug-browser target handoff (pid/profile/port/target prefix) with JSON mode and cleanup guidance (#83).
* add compact `--qa`/`--summary` output modes for perceive, actions, and report (#84).
* add `responsive-audit` / `visual-check` for bounded desktop/mobile visual QA (#86).
* refine doctor readiness to `ready | usable-with-warnings | blocked` with severity classification for advisory permission states (#87).
* expose `select_target`, `responsive_audit`, compact QA flags, and `open --reuse-url` through the MCP adapter (#89).
* honor `--max-controls` in responsive audits and report live network failure counts in `perceive --qa` summaries (#90).

### Fixes

* make `text`/`html` selector failures report search root/scope and suggest an `eval` fallback (#85).
* default explicit `text <selector>` searches to the document root so they match `eval document.querySelector(...)` (#85).
* treat unconfirmed browser permission as advisory in doctor wizard/recommendation when CDP is already usable (#87).
* share root-aware selector diagnostics with `styles` and improve no-match recovery guidance (#91).
* keep adversarial real-app campaigns inside the total-output-token gate by bounding the large-table probe and raising headroom slightly.

### Documentation

* refresh README, GitHub Pages benchmark proof, release links, and pinned install guidance for the v2.10.0 front door.
* add Browser Use mapping and awesome-list outreach research notes.

### Breaking Changes

* doctor JSON `status` values are now `ready | usable-with-warnings | blocked` (replacing `mostly-ready` / `not-ready`). Prefer the new `readiness` + per-check `severity` fields.
* `html` no-match now throws instead of returning the soft string `Element not found`.

## [2.9.1](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.9.0...v2.9.1) (2026-07-08)

### Documentation

* refresh README, GitHub Pages benchmark proof, release links, and pinned install guidance for the release front door.
* teach the README benchmark updater to refresh real-app live campaign snapshots in both README and the benchmark page.

## [2.9.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.8.0...v2.9.0) (2026-07-08)

### Features

* add a repeated live campaign benchmark loop with history trends, issue-ready diagnostics, regression comparisons, and a documented self-improvement runbook.
* add adversarial and real-app live target profiles for high-difficulty local testing, including dashboard, docs-app, auth-flow, data-table, and canvas-heavy classes.
* expand MCP problem-finding coverage with compact recovery tools, MCP live benchmarks, and MCP-vs-CLI route recommendations for latency, token, and pass-rate comparisons.

### Fixes

* keep MCP `initialize` server version in sync with `package.json` release metadata.
* fix live benchmark backlog regressions, responsive latency gating, and live-smoke no-change recovery contracts found during dogfood campaigns.
* add an isolated live benchmark run manager with owner metadata, heartbeat records, dead-owner reclaim, and port/profile allocation to prevent cross-target contamination.

### Maintenance

* compact action/report payloads and gate long-session report budgets so handoffs stay bounded under many-action sessions.
* document safe local/test-only requirements for real-app campaign targets and refresh benchmark reference commands.

## [2.8.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.7.0...v2.8.0) (2026-07-07)

### Features

* add `controls`, `verify-click`, and `qa` workflows so agents can inspect visible controls, assert expected action outcomes, and run desktop/mobile smoke checks from the CLI.
* add the stdio MCP server and adapter for agent-native doctor/list/open/perceive/action/QA/report workflows.
* promote action receipt observability with structured `chrome-cdp-ex.action-receipt.v1` JSON, report surfaces, executable recovery next steps, and post-action settlement evidence.

### Fixes

* detect stale target daemons before commands run, with explicit stop-and-retry guidance and an intentional `--allow-stale-daemon` escape hatch.
* harden no-change, closed-target, post-action observation, stale-ref, overlay, and wrong-frame recovery paths so failures produce actionable diagnostics instead of ambiguous success.
* redact sensitive action artifacts and keep long-session reports bounded for safer handoffs.

### Maintenance

* expand killer-path benchmark gates for action evidence completeness, stale-ref recovery, artifact replay, and large-app stress coverage.
* document this repository's PR target and GitHub-release publish policy.
* refresh README, technical reference, and skill guidance for the 75-command Smart Eye workflow.

## [2.7.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.6.0...v2.7.0) (2026-06-28)

### Features

* resolve the remaining Smart Eye readiness issues and close the practical-agent epic.
* add guarded-page benchmark coverage, measured baseline examples, and replay-first workflow export guidance.

### Maintenance

* extract action recovery, perception, and session report helpers into tested runtime modules.
* run docs contract checks on main PRs and keep release metadata plus first-run docs gated.

## [2.6.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.4.0...v2.6.0) (2026-06-17)

### Features

* ship Smart Eye action evidence, session reports, workflow handoffs, and benchmark-gated README proof.

### Maintenance

* add a README benchmark updater so dogfood snapshot claims stay tied to real benchmark JSON.

## [2.4.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v2.3.0...v2.4.0) (2026-04-26)


### Features

* add readiness and flow tooling — new `doctor` / `ready` one-call diagnostics (Node version, skill install path, daemon socket state, CDP reachability) and `flow` sequential pipeline runner with `wait dom stable` / `wait network idle` aliases ([f3b081d](https://github.com/EndeavorYen/chrome-cdp-ex/commit/f3b081d28b862ff176e3010b41ff709ae072d3a3))


### Bug Fixes

* implement `record` command (timeline of DOM/console/network/navigation events with `--action` and `--until` modes) and harden `cascade` source-map resolution for Vite / CSS Modules / Vue SFC pipelines ([2273c84](https://github.com/EndeavorYen/chrome-cdp-ex/commit/2273c847e3c5fc83d69738b821be1e4dc404507a))
* polish `record` and `cascade` dogfood issues uncovered while using the tools end-to-end ([153a96f](https://github.com/EndeavorYen/chrome-cdp-ex/commit/153a96f91e6622b68c199c1ec95cb2273946e8ab))

## [2.3.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/pi-chrome-cdp-v2.2.0...pi-chrome-cdp-v2.3.0) (2026-04-02)


### Features

* add 'open' command to create new tabs ([17f71cd](https://github.com/EndeavorYen/chrome-cdp-ex/commit/17f71cd7018ea3cd5c12bc6008f74424b73d4750))
* add [@ref](https://github.com/ref) system, action feedback, scope flags, and 7 new commands ([de73c42](https://github.com/EndeavorYen/chrome-cdp-ex/commit/de73c420cdf49c5227d6d95d93a7b03dbe4df1e0))
* add [@ref](https://github.com/ref) system, perceive diff, batch commands, security validation, and annotated screenshots ([a687ca5](https://github.com/EndeavorYen/chrome-cdp-ex/commit/a687ca5eb969279e03e4d4fa5e4361eb46f835c4))
* add CI/CD pipeline with GitHub Actions and release-please ([bb19bee](https://github.com/EndeavorYen/chrome-cdp-ex/commit/bb19beeea6578f1c0fba3ce3b77a1c5d96785faf))
* add Linux Flatpak browser paths to DevToolsActivePort discovery ([1fd55c7](https://github.com/EndeavorYen/chrome-cdp-ex/commit/1fd55c777125eff23e6ad3a972e694999a3a5bfb))
* add Linux Flatpak browser paths to DevToolsActivePort discovery ([59199f1](https://github.com/EndeavorYen/chrome-cdp-ex/commit/59199f146428e12ed786b7ac73ad25db6aa5686d))
* add perceive/elshot commands, rewrite skill for perceive-first observation ([e35ec41](https://github.com/EndeavorYen/chrome-cdp-ex/commit/e35ec41e99a104febc106ff80a31b8171efcfa30))
* add plugin.json for Claude Code marketplace integration ([c14bc60](https://github.com/EndeavorYen/chrome-cdp-ex/commit/c14bc601696ece549aee97557e9c348eb20d8fa3))
* add redesign experiment, showcase page, and GitHub Pages deployment ([297f477](https://github.com/EndeavorYen/chrome-cdp-ex/commit/297f477843dde34abe1f5d22b14de8adaf2bd733))
* add scanshot command for segmented full-page capture ([ca4f45e](https://github.com/EndeavorYen/chrome-cdp-ex/commit/ca4f45eb2fd8fd63a54ca5b00ba849c2a9abfe53))
* add Windows support via named pipes ([3e3e1f0](https://github.com/EndeavorYen/chrome-cdp-ex/commit/3e3e1f0bcd894ea31f84c95604bed9959fa7fba7))
* auto-perceive for nav/scroll/viewport, batch pipe syntax + parallel mode ([414ad67](https://github.com/EndeavorYen/chrome-cdp-ex/commit/414ad6768dd7ad9fba3eeb9bd66245f7d029b959))
* Electron CDP support via CDP_PORT env var ([dfd7771](https://github.com/EndeavorYen/chrome-cdp-ex/commit/dfd77719a7b1be990c2db0158947f6a8843fa6e4))
* expand browser discovery to Chrome, Chromium, Brave, Edge, Vivaldi on macOS/Linux ([356d928](https://github.com/EndeavorYen/chrome-cdp-ex/commit/356d928c27f50a9f0c3aae3e2b8c94c5d90b0c87))
* inline hints for text/perceive/waitfor, AI chatbot workflow pattern ([7db4157](https://github.com/EndeavorYen/chrome-cdp-ex/commit/7db4157e967ea19a2af18efd6751a602f3cf91e1))
* merge local fork with upstream — add 13 commands, background observation, and WSL2 support ([dd522cc](https://github.com/EndeavorYen/chrome-cdp-ex/commit/dd522ccbca751b61136d7c6400470817d7b8232e))
* multi-tier screenshot fallback for Electron, snapshot→perceive guidance ([a9eace7](https://github.com/EndeavorYen/chrome-cdp-ex/commit/a9eace76fabd12c97fecf9038902ae20c55706b0))
* open auto-attaches + auto-perceives, single-tab comparison workflow ([461d79d](https://github.com/EndeavorYen/chrome-cdp-ex/commit/461d79da2c5946c88fe5a4d9251417abd8d0dac3))
* **perceive:** collect table cell style hints in browser-side eval ([a44ae5e](https://github.com/EndeavorYen/chrome-cdp-ex/commit/a44ae5e5cb9f0a8452b4b5f6d54f9776c896e18a))
* **perceive:** render style hints on table cell AX nodes ([5720485](https://github.com/EndeavorYen/chrome-cdp-ex/commit/5720485a23e86cfadf53b8e2d646a4cc0350d3e8))
* redesign showcase page — auto-scaling iframes, chrome-cdp highlight, view buttons ([8c6eb9a](https://github.com/EndeavorYen/chrome-cdp-ex/commit/8c6eb9af5bd1f7a54571a48370956398c265c909))
* text selector, waitfor --text, perceive -x exclude, compact diff ([d3383bd](https://github.com/EndeavorYen/chrome-cdp-ex/commit/d3383bd1da261f20d07bd8f5be04fff2f4fb05f4))
* v2.2.0 — inject + cascade commands, CSS origin tracing ([af63acd](https://github.com/EndeavorYen/chrome-cdp-ex/commit/af63acd23c7636423cf73731e92e095dde127759))
* waitfor --gone for streaming end detection, chatbot workflow ([8a72cad](https://github.com/EndeavorYen/chrome-cdp-ex/commit/8a72cad2b5639859796e89f502a89d4781549bcb))


### Bug Fixes

* perceive truncated-row leak, icon noise, and shot+scroll guidance ([c2699fa](https://github.com/EndeavorYen/chrome-cdp-ex/commit/c2699fac9c35659c9e42f847c660302a35543371))
* **perceive:** address style hint matching issues from code review ([1549dc1](https://github.com/EndeavorYen/chrome-cdp-ex/commit/1549dc1eb560cd5ceb8d235c8b57a0d7e3c2d2cf))
* reduce perceive noise and discourage scanshot for comparisons ([fb403d3](https://github.com/EndeavorYen/chrome-cdp-ex/commit/fb403d34fcbf62d6132e11db837d4c1c72777efa))
* strengthen skill trigger to prevent agents from using Playwright instead ([fdba9cc](https://github.com/EndeavorYen/chrome-cdp-ex/commit/fdba9ccac9f5e092984483a3c444ef4c725a668b))
* update pages cache after 'open' command ([05d8562](https://github.com/EndeavorYen/chrome-cdp-ex/commit/05d8562b45ef1b5d45f3a6e9038d9bee4dda69ad))


### Miscellaneous

* add Electron trigger words, unify skill description to English-only ([d653faf](https://github.com/EndeavorYen/chrome-cdp-ex/commit/d653fafd1e5a3ad31b8249cea70267381c7c9725))
* remove experiment round screenshots ([b410118](https://github.com/EndeavorYen/chrome-cdp-ex/commit/b4101186c8d33e91a8abbf7f0cac4fbdc8ba5e84))
* rename skill from chrome-cdp to chrome-cdp-ex ([3f61dfa](https://github.com/EndeavorYen/chrome-cdp-ex/commit/3f61dfa1030897ecf6f18d141019c894d64b7df9))


### Refactoring

* extract perceivePageScript, fix duplicate export, add design doc ([0b3ceff](https://github.com/EndeavorYen/chrome-cdp-ex/commit/0b3ceff0976cbe51c0117a545c0cb8ce3f76a166))
* extract shared helpers, fix scanshot clipping bug ([b5eb336](https://github.com/EndeavorYen/chrome-cdp-ex/commit/b5eb3360af1002ac00a9a051811cd32e36e7be03))
* improve skill trigger coverage and reduce SKILL.md redundancy ([01b0512](https://github.com/EndeavorYen/chrome-cdp-ex/commit/01b05125e10f9c16df564c162d94d8dea6040b21))
* **perceive:** simplify style hints — single pass, capped scan ([80efded](https://github.com/EndeavorYen/chrome-cdp-ex/commit/80efdeddada7da145653672957b864ea2d593715))
* remove listDaemonSockets, use pages cache everywhere ([da4a87e](https://github.com/EndeavorYen/chrome-cdp-ex/commit/da4a87e06577ce37885591b8f317316dafc157e8))


### Documentation

* add design spec for reducing agent screenshot overuse ([b49d816](https://github.com/EndeavorYen/chrome-cdp-ex/commit/b49d816659d0b12053bc43542297e44aa47548cf))
* add implementation plan for reducing screenshot overuse ([c70d33a](https://github.com/EndeavorYen/chrome-cdp-ex/commit/c70d33a03c171434d2bb007a4c5a241bee8de56e))
* add WSL2→Windows architecture diagram to README ([457cf82](https://github.com/EndeavorYen/chrome-cdp-ex/commit/457cf82c4c91a7b06eccbee4f83d69f2d9f34219))
* address spec review — text-content keying, scope non-table to future ([b49d401](https://github.com/EndeavorYen/chrome-cdp-ex/commit/b49d40147578ec972c68ea5b50c82411b3646031))
* compact README — bullet features, mermaid sequence diagram, merged install block ([d34f7e3](https://github.com/EndeavorYen/chrome-cdp-ex/commit/d34f7e372e49dea8812ef1b28a80df68e534fa18))
* promotional README rewrite with PK-tested comparison data ([d8427ea](https://github.com/EndeavorYen/chrome-cdp-ex/commit/d8427eaefbd6dffd02002dd004d27b77ed4cfe7f))
* rename to chrome-cdp-ex, restructure README with feature highlights ([9bbebb2](https://github.com/EndeavorYen/chrome-cdp-ex/commit/9bbebb267b42437cbe6b737d02941993756aa3d2))
* revamp README with comparison table, [@ref](https://github.com/ref) demo, and simpler install steps ([2537b79](https://github.com/EndeavorYen/chrome-cdp-ex/commit/2537b79c7fa46619c0491ed7f2bc670f0c6340f6))
* rewrite README for impact, consolidate CHANGELOG to v2.1.0 ([68262f6](https://github.com/EndeavorYen/chrome-cdp-ex/commit/68262f604505b0740e841d27ca98cad58387e3e1))
* **SKILL.md:** scenario-driven verification guidance, document style hints ([87aadb5](https://github.com/EndeavorYen/chrome-cdp-ex/commit/87aadb510bb364053858f454bb8964126fc172d5))
* update README and CHANGELOG for perceive/elshot commands ([a252907](https://github.com/EndeavorYen/chrome-cdp-ex/commit/a25290773b00aafb499683199c40fdb3583e844b))


### Tests

* add unit tests with Vitest, extract buildPerceiveTree for testability ([6c19149](https://github.com/EndeavorYen/chrome-cdp-ex/commit/6c191490b9964fc6c294bd483844a50998ef707b))

## v2.2.0

Two new commands: **Operational** (`inject`) and **Cognitive** (`cascade`). 44 commands total.

### New commands

- **`inject <target> --css|--css-file|--js-file|--remove`** — Live CSS/JS injection with tracking and removal. Each injection gets a `data-cdp-inject` ID for targeted cleanup. Validates URLs via `validateUrl` to prevent SSRF. Eliminates the repetitive `eval` boilerplate for frontend development.
- **`cascade <target> <selector|@ref> [property]`** — CSS origin tracing via `CSS.getMatchedStylesForNode`. Shows the full cascade: which rule won, which were overridden, source file + line number, and inherited properties. Includes inline `style=""` attributes (highest specificity). Answers "which file do I edit to change this style?" in one command.

### Improvements

- **Extracted `perceivePageScript()`** — the 190-line browser-side JS for `perceive` is now a named, testable function instead of an inline template literal.
- **Optimized cursor-interactive scan** — `perceive -C` uses targeted CSS selectors instead of `querySelectorAll('*')`, reducing `getComputedStyle` calls on large pages.
- **`_screenshotTier` reset** — screenshot fallback tier now resets per daemon session, preventing cross-target state leaks.
- **Organized `__test__` exports** — grouped by category with comments; removed duplicate `isRef` export.
- **`CSS.enable`** added to daemon initialization for `cascade` support.
- **SKILL.md** — four-tier perception model (added Temporal tier for future `record` command), decision tables for when to use `record` vs `perceive --diff`.

### Tests

- 163 → 195 tests (+32)
- New: `perceivePageScript` (5), `buildPerceiveTree` integration (6), `injectStr` (9+3 security), `cascadeStr` (8+1 inline style)

## v2.1.0

This release consolidates all enhancements since the fork merge into a single version. 42 commands total (14 from upstream, 28 added).

### `@ref` system and action feedback

- **`@ref` indices** — `perceive` assigns every interactive element a ref (`@1`, `@2`, `@3`...) with bounding coordinates `(x,y w×h)`. Refs work as targets in `click`, `fill`, `hover`, and `elshot` — no CSS selectors needed.
- **Action feedback** — `click`, `clickxy`, `press` (Enter/Escape/Tab), and `select` automatically wait for DOM to settle and return a perceive diff showing what changed. No need to manually run `perceive --diff` after actions.
- **`perceive --diff`** — show only changes since last perceive call. Efficient for monitoring page state after interactions.
- **`shot --annotate` / `-a`** — viewport screenshot with red `@ref` bounding box overlays on every interactive element.

### Perceive-first observation

- **`perceive <target> [flags]`** — enriched accessibility tree with inline visual layout annotations. Combines summary metadata (title, URL, viewport, scroll position, interactive element counts, console health) with the compact AX tree, annotated with height, background color, font size, display mode, and viewport visibility (↑above fold / ↓below fold). Gives agents complete page understanding in ~200-400 tokens without screenshots.
  - `--diff`: show only changes since last perceive
  - `-s <sel>` / `--selector`: scope to CSS selector subtree
  - `-i` / `--interactive`: interactive elements only
  - `-d N` / `--depth N`: limit tree depth
  - `-C` / `--cursor-interactive`: include non-ARIA clickable elements (`@c` refs)
- **Style anomaly hints** on table cells — annotates non-default background colors, bold text, and unusual text colors (e.g., `[cell] 70.0%  bg:rgb(255,200,200)  bold`)
- **`elshot <target> <sel|@ref>`** — element-level screenshot: scrolls the element into view, clips capture to its bounding box with 8px padding. No DPR confusion.
- **Perceive-first observation strategy** in SKILL.md — three-tier model (perceive → elshot → scanshot) guiding agents to use structured text first, screenshots as secondary verification.

### New commands (since fork)

- **`text <target>`** — clean text content (strips scripts, styles, SVG)
- **`table <target> [selector]`** — full table data extraction (tab-separated, no row limit)
- **`back <target>`** — navigate back in browser history
- **`forward <target>`** — navigate forward
- **`reload <target>`** — reload current page
- **`closetab <target>`** — close a browser tab
- **`netlog <target> [--clear]`** — network request log (XHR/Fetch/Document with status + timing)
- **`cookieset <target> <cookie>`** — set a cookie (`name=value; domain=.example.com; secure`)
- **`cookiedel <target> <name>`** — delete a cookie by name
- **`dialog <target> [accept|dismiss]`** — dialog history; set auto-accept or auto-dismiss
- **`viewport <target> [WxH]`** — show or set viewport size (e.g., `375x812`)
- **`upload <target> <selector> <paths>`** — upload file(s) to `<input type="file">`
- **`batch <target> <json>`** — execute multiple commands in one call (reduces IPC overhead)
- **`scanshot <target>`** — segmented full-page capture: viewport-sized screenshots with 10% overlap
- **`status <target>`** — URL, title + buffered console errors and exceptions
- **`console <target> [--all|--errors]`** — console buffer (default: unread only)
- **`summary <target>`** — token-efficient page overview (~100 tokens)
- **`fullshot <target> [file]`** — full-page screenshot (single image)
- **`press <target> <key>`** — press keyboard key (Enter, Tab, Escape, Backspace, Space, Arrow*)
- **`scroll <target> <dir|x,y> [px]`** — scroll by direction or coordinates (default 500px)
- **`hover <target> <sel|@ref>`** — hover over element (triggers :hover, tooltips)
- **`waitfor <target> <selector> [ms]`** — wait for element to appear (default 10s)
- **`fill <target> <sel|@ref> <text>`** — clear field + type text (form filling)
- **`select <target> <selector> <value>`** — select dropdown option by value
- **`styles <target> <selector>`** — computed styles (meaningful props only)
- **`cookies <target>`** — list cookies for the current page
- **`snap --full`** — option for complete AX tree (compact is now default)

### Infrastructure

- **Background observation**: `RingBuffer`-based console, exception, and navigation buffering in the daemon
- **Realistic input simulation**: `click` and `loadall` use CDP `Input.dispatchMouseEvent` (mouseMoved → mousePressed → mouseReleased) instead of `el.click()`
- **Smart daemon reuse**: `list` reuses existing daemon sockets, avoiding unnecessary "Allow debugging" prompts
- **Smart target resolution**: commands check running daemon sockets before falling back to pages cache
- **Security validation**: eval expressions are checked for dangerous patterns
- **Plugin manifest**: `plugin.json` for Claude Code integration
- **CLAUDE.md**: project overview, architecture diagram, coding conventions
- **Unit tests**: Vitest test suite with extracted `buildPerceiveTree` for testability
- **WSL2 support**: proven patterns for controlling Windows Chrome from WSL2
- **`edge://` filtering**: `getPages()` filters out Edge internal pages

### Merged from upstream v1.0.2

- **Flatpak browser paths**: Linux Flatpak installations auto-discovered
- **`CDP_HOST` env var**: connect to Chrome on a non-localhost host
- **`LOCALAPPDATA` for RUNTIME_DIR**: Windows daemon sockets go to `%LOCALAPPDATA%\cdp`
- **Daemon error handler**: listen failures reported clearly instead of silent crash
- **`open` cache refresh**: new tabs immediately reflected in pages cache

## v1.0.2 (upstream)

- Windows/WSL: use LOCALAPPDATA, CDP_HOST, add daemon error handler

## v1.0.1 (upstream)

- Linux Flatpak browser path discovery
- MIT LICENSE file added

## v1.0.0 (upstream)

- Initial release: list, snap, eval, shot, html, nav, net, click, clickxy, type, loadall, evalraw, open, stop
