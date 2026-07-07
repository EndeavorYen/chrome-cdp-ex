# Self-Improvement Loop

Use this runbook when improving `chrome-cdp-ex` through repeated live-test rounds. A round is complete only when the issue is closed by a merged PR to `origin/main` and the next gap has been identified from current evidence.

## Round Contract

Each round has five steps:

1. Self-assess the current tool from live evidence and code review.
2. Open one or more GitHub issues with clear acceptance criteria.
3. Fix every issue selected for the round, including tests and docs when needed.
4. Review, wait for CI, and merge the PR to `origin/main`.
5. Record what is still weak and select the next round.

Do not count a brainstorm, local-only commit, or open PR as a completed round.

## 1. Self-Assess

Start from current state, not memory:

```bash
git status --short --branch
gh issue list --state open --limit 50
npm run benchmark:campaign -- --rounds 10 --types mcp,killer,large-app --history ./campaign-history.jsonl --output ./campaign.json
```

Use `History trend` to compare against the previous campaign. Treat negative pass-rate deltas, rising average output tokens, rising max step tokens, or slower culprit steps as candidates for the next issue. If a campaign fails, inspect `issueDrafts` in the JSON output before writing a new issue by hand.

## 2. Open Issues

Create issues from evidence, not vibes. Every issue should include goal, scope, acceptance criteria, reproduction command, culprit step or metric, and suggested labels.

```bash
gh issue create --title "Fix benchmark regression" --body "Goal: ... Acceptance: ..." --label "type: benchmark" --label "priority: p1" --label "status: ready"
```

Prefer one sharply scoped issue per round unless multiple issues must ship together to make the round coherent.

## 3. Implement And Verify

Create a feature branch from clean `main`, write a failing test for the selected issue, then implement the smallest behavior that satisfies the issue acceptance criteria.

```bash
npm test
npm run lint
npm run check:docs
npm run benchmark:campaign -- --rounds 2 --types mcp,killer --history /tmp/chrome-cdp-ex-loop-history.jsonl
```

Use the full test suite for merge readiness. Use a focused live campaign for the feature path, and a longer campaign when the issue changes benchmark gates, token budgets, browser isolation, or MCP behavior.

## 4. Review And Merge

Review the diff against the project's existing conventions. Prioritize real blockers: wrong issue scope, missing acceptance coverage, misleading benchmark evidence, token regressions, fragile live-browser behavior, or docs that make commands unrepeatable.

```bash
gh pr create --base main --head <branch> --title "..." --body "..."
gh pr checks <number>
gh pr merge <number> --merge --delete-branch
```

Do not merge until local gates and GitHub CI are green. After merge, verify the local checkout is back on `main`, clean, and synchronized with `origin/main`.

## 5. Next-Round Backlog

After merge, re-run the self-assessment step or inspect the latest campaign history. If the current round fixed the selected issue, close or mark it done. If the work exposed a new weakness, open a follow-up issue before starting the next implementation branch.

Useful next-round signals:

- `History trend` shows worse pass rate, average output tokens, max step tokens, or slowest step latency.
- `issueDrafts` contains a high-confidence failure report.
- The review found a gap that was out of scope for the current issue.
- A live benchmark passes but with little headroom.
- The operator flow still requires manual interpretation that could be encoded in output or docs.
