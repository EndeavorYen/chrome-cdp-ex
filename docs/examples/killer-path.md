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

## What Success Looks Like

`perceive` returns a compact page map with `@ref` handles, layout hints, and console health. `click` or `fill` returns action evidence, including dispatch status, observed DOM diff, and console/network deltas. `perceive --since-action` answers what changed because of the last action, and `report` gives the session timeline plus next steps.

## If It Fails

Read the `Recovery:` block before retrying. It names the failure kind, gives the primary `Run:` command, and keeps the short `Next:` command for copy-paste recovery. For stale refs, run `perceive <target> -C -d 8` again or switch long loops to stable CSS selectors.
