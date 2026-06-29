# Killer Path

> **TL;DR** - Run `doctor`, get or open a target, `perceive` the page, act once, inspect `--since-action`, then `report`. This is the shortest path to prove `chrome-cdp-ex` can see and act in a real browser session.

## Two-Minute Run

Use the existing Chrome/Edge/Brave tab when possible; use `open` only when `list` has no useful target.

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node skills/chrome-cdp-ex/scripts/cdp.mjs list
# If list has no useful target:
node skills/chrome-cdp-ex/scripts/cdp.mjs open https://example.com
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
node skills/chrome-cdp-ex/scripts/cdp.mjs click <target> @ref
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --since-action
node skills/chrome-cdp-ex/scripts/cdp.mjs report <target>
```

`report` shows the latest 20 actions by default to keep handoffs small. Add `--last N` for a narrower handoff or `--all` when you intentionally need the full timeline; the JSONL log path in the report still preserves the long session history.

For forms, replace the action line with:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs fill <target> "input[name=email]" "you@example.com"
```

## Failed Action Recovery

When an action misses, keep the JSON handoff instead of guessing:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs click <target> "#missing" --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs overlay <target> --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs frame <target> --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

The failed action JSON exposes `effects.failure.kind`, `recommendation`, and executable `nextSteps`; use those before retrying the same action.

## CSS Trace

Use `cascade` when the visible issue is styling and the next agent needs the source file, selector, and line:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs cascade <target> @ref background-color --format json
```

The JSON handoff includes `properties[].winner.source` and `editTarget` so the next step can edit the winning rule rather than re-inspecting DevTools.

## Export Handoff

After a useful exploration, capture the workflow and export the portable test draft:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs record-actions <target> --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs replay <target> --file record-actions.json --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs export-playwright <target> --format json
```

`record-actions` preserves replayable steps plus live-only environment controls. Save the JSON artifact as `record-actions.json`, replay its portable subset, then export the Playwright draft. `replay` reports ok, failed, skipped, and recovery next steps; `export-playwright` reports exported, skipped, review-needed, and live-only work so reusable tests stay honest about what needs human review.

## What Success Looks Like

`perceive` returns a compact page map with `@ref` handles, layout hints, and console health. `click` or `fill` returns action evidence, including dispatch status, observed DOM diff, and console/network deltas. `perceive --since-action` answers what changed because of the last action, and `report` gives the session timeline plus next steps.

## If It Fails

Read the `Recovery:` block before retrying. It names the failure kind, gives the primary `Run:` command, and keeps the short `Next:` command for copy-paste recovery. For stale refs, run `perceive <target> -C -d 8` again or switch long loops to stable CSS selectors. For stale daemons after a checkout update, run the printed `cdp stop <target>` command, then rerun the original command.
