# Resolve Issues #115-#119 Design

## Goal

Close the five open reliability gaps in responsive auditing, action/report handoff,
screenshot capture, blank-page classification, and target binding without adding a
runtime dependency or creating different CLI and MCP behavior.

## Chosen Architecture

Use small pure classifiers for decisions and keep browser-specific evidence
collection bounded inside the existing CDP command path.

- A shared page-health classifier consumes URL, visible text, DOM size, visible
  controls, geometry, and readiness. `perceive --qa`, action QA, and
  `responsive-audit` use the same result and expose its evidence when it affects a
  verdict.
- Responsive audit collects at most a bounded number of internally clipped
  controls and material interactive/sticky overlaps. Findings include a stable
  selector or accessible name, both rectangles, overlap ratio, severity, and a
  suppression reason for intentional scroll lists.
- Screenshot capture samples pixels through a temporary in-page canvas and retries
  once only when a near-black frame contradicts a light rendered page. The retry
  uses `fromSurface: false`, is bounded by the existing screenshot timeout, and
  reports retry count and winning method.
- Report recommendation selection stops at a newer successful action, so a
  resolved failure remains in history but no longer controls top-level recovery.
- Target commands resolve against live targets before cached daemon state. Daemon
  metadata carries the bound target id, and structured output identifies the
  requested prefix, bound id, resolved id, resolution source, and rebind status.

Keeping these decisions pure makes deterministic regressions possible while the
CLI remains the single implementation used by MCP.

## Rejected Alternatives

1. Add PNG and DOM-analysis dependencies. This would simplify pixel decoding but
   enlarge the published skill and introduce supply-chain surface for one bounded
   heuristic.
2. Put every fix directly in `cdp.mjs`. This matches historical layout but makes
   four independent reliability policies harder to test and reuse consistently.
3. Retry every dark screenshot. This would penalize legitimate dark applications
   and could hide persistent compositor failures.

## Contracts

### Responsive findings

Only visible interactive elements count. Internal clipping requires a nearest
scroll container with overflow beyond one pixel and a control rect materially
outside its visible content rect. Scroll containers marked with
`data-cdp-audit-scroll="intentional"`, listbox/feed roles, or a small offscreen
ratio are suppressed. Overlap warnings require an interactive element and a
fixed/sticky/dialog/primary-action counterpart with at least 20% coverage of the
smaller element. JSON arrays are capped.

### Blankness

`blank` requires multiple stable signals: a blank URL or empty meaningful content,
no visible controls, negligible visible text, and no meaningful document geometry.
A changed action, populated accessibility/DOM evidence, visible controls, or
non-trivial text is evidence against blankness. Loading samples may be
`indeterminate`; callers take one bounded resample before treating them as blank.

### Screenshot retry

A retry is allowed only once when sampled pixels are at least 80% near-black and
the computed page/background appearance is light. Dark or unknown pages do not
retry. Persistent disagreement is returned as a warning diagnostic rather than
silently treated as healthy.

### Target binding

The requested prefix must resolve to exactly one live target. A daemon is reusable
only when its bound target id equals that live result. A mismatched daemon is
stopped/rebound once; if the mismatch remains, the command fails with actionable
diagnostics. Structured command output includes the resolution record.

## Verification

- Deterministic unit regressions cover all acceptance criteria and bounded output.
- Existing clean responsive, dark screenshot, blank document, ambiguity,
  `open --reuse-url`, report compact/full, and MCP route tests remain green.
- Full gates: test, lint, docs contract, package dry-run, audit, and a local live
  CLI smoke against a disposable debug browser.
- A separate review pass checks the complete diff before PR creation. GitHub CI
  must pass before merge and release.

