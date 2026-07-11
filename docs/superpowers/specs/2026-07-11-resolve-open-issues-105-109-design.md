# Resolve Open Issues #105-#109 Design

## Goal

Close the five open reliability and control-flow issues without broadening the
CLI beyond their acceptance criteria. Preserve existing command behavior unless
an issue explicitly requires a safer failure mode.

## Scope

### #105: occupied debug-browser port

Before launching a disposable browser, probe the requested host and port. Any
existing TCP listener is a hard failure, whether or not it serves a responsive
CDP endpoint. The error names the port and tells the operator to choose another.
The existing post-launch `/json/version` readiness check remains the source of
truth for a free-port launch.

### #106: multi-statement async eval results

Keep single-expression `await` and explicit `return` behavior unchanged. For a
multi-statement async expression without an explicit `return`, transform the
final expression statement into a return value before constructing the async
IIFE. If a safe final-expression split cannot be established, fail with an
actionable message instead of reporting an empty successful result. `eval64`
uses the same evaluator; fire-and-forget keeps its non-awaited contract.

### #107: smooth-scroll click coordinates

Centralize scroll settling for pointer-coordinate resolution. After
`scrollIntoView`, wait for consecutive stable animation-frame samples, then
read the final bounding rectangle. Apply the same helper semantics to `@ref`
and CSS-selector click paths. Already-visible, stable targets should resolve on
the minimum sample count without a fixed long delay.

### #108: console baseline

Add strict console-option parsing for default unread mode, `--all`, `--errors`,
and `--clear`, with optional `--format text|json`. `--clear` empties both console
and exception buffers and advances both read cursors, returning an explicit
acknowledgement. Unknown flags fail non-zero with supported-option guidance.
Subsequent `console`, `summary`, and `perceive` health operate only on entries
recorded after the baseline.

### #109: bounded state-aware repeat and flow assertions

Extend `repeat` with exactly one optional stop condition:

- `--until-selector <css>`: stop when the selector exists.
- `--until-selector-missing <css>`: stop when the selector no longer exists.
- `--until-text <text>`: stop when visible page text contains the value.

The finite repeat count remains mandatory and capped. The condition is checked
after each successful settled iteration, so DOM replacement is naturally
re-evaluated. An inner-command failure remains fail-fast unless `--continue` is
present. Reaching the cap without satisfying a requested condition is a
distinct command failure with an iteration transcript.

Add `assert selector <css>`, `assert selector-missing <css>`, and
`assert text <value>` steps to `flow`. Assertions are postconditions: a failed
assertion halts the flow and marks later steps skipped. The existing simple
semicolon flow grammar remains; shell-hostile or semicolon-containing values
must be transported with existing quoting/base64 mechanisms rather than adding
a second DSL.

## Architecture

Keep the orchestration in `cdp.mjs`, matching the repository's current command
layout, but isolate pure parsing, async-eval transformation, condition modeling,
and output formatting into testable helpers. Browser-dependent probes receive
injected CDP/network dependencies where practical so occupied ports, DOM
replacement, and cap exhaustion can be tested deterministically.

The daemon dispatcher remains the single execution boundary. `repeat` invokes
its inner command, settles through the existing action/flow path, then invokes a
condition probe. `flow` routes assertion steps to the same condition probe, so
repeat and flow cannot disagree about selector or text semantics.

## Error And Output Contract

- Existing successful text output stays readable and backward compatible.
- State-aware repeat includes every attempted iteration and the matching
  condition in its transcript.
- Satisfied conditions finish successfully and identify the iteration.
- Unsatisfied capped conditions throw a classified, non-zero error containing
  the transcript.
- Invalid or conflicting condition flags fail before any browser mutation.
- Unknown console flags fail before advancing cursors.
- JSON output is added only where the command already advertises JSON; new
  fields remain versioned under existing schemas or a narrowly bumped schema.

## Testing And Verification

Use red-green TDD for every issue:

- occupied responsive and unresponsive ports, plus a free-port readiness path;
- single-expression await, explicit-return multi-statement await, inferred final
  expression, ambiguous input failure, eval64, and fire-and-forget preservation;
- smooth-scroll fixtures for `@ref` and selector clicks, including mobile-sized
  viewport and already-visible fast-path coverage;
- console clear across buffers, cursors, summary/perceive health, new entries,
  existing modes, JSON acknowledgement, and unknown flags;
- repeat early success, absence condition, text condition, cap exhaustion,
  inner failure, `--continue`, DOM replacement, conflicting flags, quoting, and
  flow assertion pass/fail/skip behavior.

Run focused tests during each red-green cycle, then the complete test suite,
lint, docs contract, package dry-run, and a focused live browser smoke covering
smooth-scroll click, console baseline, async eval, and state-aware repeat/flow.
The PR must pass GitHub CI and a Grok Build CLI review. Technically valid Grok
findings receive their own test-first fix cycle; merge is prohibited until the
review verdict is an explicit pass.

## Non-Goals

- Unbounded loops or time-only loops.
- Automatic stale `@ref` remapping.
- Arbitrary `--until-eval` execution.
- A general-purpose flow language or nested repeat/batch recursion.
- npm registry publication or release creation.
