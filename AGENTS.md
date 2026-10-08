# AGENTS.md - chrome-cdp-ex

## Product goals

This section is the single authoritative source for product goals. Other docs point here. Do not keep a second copy of these rules.

chrome-cdp-ex is effective, efficient, and easy for agents to use. When those goals conflict, the order is effective, then easy for agents, then efficient.

### Effective (correct and honest)

- Never report a false success. A click on a covered element is refused: nothing is clicked, and the result is not a successful click. A click that changes nothing is reported as no-change, not as a change.
- Results must be grounded in observed evidence. Do not claim a page change, a hit target, or a side effect that was not observed.

### Efficient (fast, low token)

- Default output is concise.
- Bulk or sensitive detail is opt-in, using the flags that exist in the runtime: `--verbose` (`-v` on `shot`, the long coordinate-mapping text), `--full` (the complete `snap` tree, or the full action JSON envelope), and `--unsafe-full` (unredacted or unbounded output on `netlog`, `checkpoint`, and `components`; on action commands it selects the same full envelope as `--full`).
- Any change to perceive, act, or output format must report before/after `agentChars` and `wallMs`. `agentChars` is the Unicode code-point length of agent-facing stdout plus stderr. `wallMs` is wall-clock milliseconds for the scored commands.
- Measure that change with `npm run benchmark:slice1`. Do not treat it as a merge gate. That matches the existing stance on `npm run benchmark:campaign` (10+ mixed rounds, adversarial seeds) and validation-lab phases 4–7: those are not merge requirements either.

### Easy for agents

- A successful action prints a one-line receipt.
- Every error states the cause plus the next executable command.
- Output format is stable and predictable. Do not rename, reorder, or drop a field an agent already uses without a versioned contract change.

### Trade-offs

- Order: effective > easy for agents > efficient.
- Never sacrifice correctness to save tokens.
- Never drop a field the agent needs for its next step.

### Pull requests

- Every PR body must state its impact on the three goals (effective, efficient, and easy for agents), including when a goal is unchanged.

## Pull Request Policy

- Open PRs against this repository's own remote main branch: `origin/main` (`EndeavorYen/chrome-cdp-ex:main`).
- Do not target an `upstream` remote for this project unless the user explicitly asks for an upstream contribution.

## Merge gate

Default local gate for ordinary and `musk/live-path` merges:

```bash
npm test
npm run lint
npm run check:docs
```

When attach, perceive, or act code changes and a supported browser exists, also run `npm run smoke:live`.

Do not treat `npm run benchmark:campaign` (10+ mixed rounds, adversarial seeds) or validation-lab phases 4–7 as merge requirements. Do not police npm registry publish as an agent process for this repository.
