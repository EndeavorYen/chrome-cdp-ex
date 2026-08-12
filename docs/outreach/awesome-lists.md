# Awesome-list and directory outreach research

Status: research note only. **Do not auto-submit external changes** from agents without explicit human approval.

Phase status: **Phase 8A evidence prerequisite complete locally; Phase 8B public-surface correction approved**. Before each external action, refresh [the Codex for OSS evidence baseline](codex-for-oss-evidence.md), verify the destination's current contribution rules, and retain a separate approval boundary for community posts and application submission.

## Product one-liner (draft)

> **chrome-cdp-ex** — give coding agents eyes and hands on your *already open* Chrome/Edge/Electron session via CDP: perceive layout, act with receipts, recover from overlays/stale refs, and hand off reports. Zero npm runtime deps, Node 22+.

## Candidate targets

| Target | Why relevant | Notes / eligibility |
|---|---|---|
| [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) (and forks) | Already curated; description is stale at 68 commands / Claude-only positioning | Comment on existing issue #1157 with the approved neutral 81-command description; its current CONTRIBUTING guide says not to open a recommendation PR |
| Awesome Codex Skills lists | Codex CLI-skill installation was live-validated on the historical Phase 1 candidate; current Runtime v3 fixture proof is separate | Submit only to an active, relevant list with the exact evidence boundary and Codex Killer Path |
| [awesome-mcp-servers](https://github.com/modelcontextprotocol/servers) / community MCP lists | MCP stdio server | List as community server; link repo + MCP tool summary |
| [awesome-browser-automation](https://github.com/atinfo/awesome-test-automation) / Playwright-adjacent lists | Browser automation category | Position as live-session attach, not E2E replacement |
| Claude Code plugin marketplaces / directories | Plugin install path | Already has `.claude-plugin/plugin.json`; follow marketplace rules |
| [awesome-devtools](https://github.com/ChromeDevTools/awesome-chrome-devtools) | CDP tooling | Fit under automation/devtools utilities if list accepts CLI tools |
| Agent browser / computer-use resource lists | Agent perception | Emphasize Action Receipt + recovery, not generic scraping |

Search refresh commands:

```bash
# Re-check list activity and contribution guides before submitting
gh search repos "awesome claude code" --sort stars --limit 10
gh search repos "awesome mcp servers" --sort stars --limit 10
```

## Draft description-refresh comment

```markdown
Since the entry was curated, chrome-cdp-ex has evolved into an 81-command,
zero-runtime-dependency browser runtime with documented setup for Claude Code,
Codex, Cursor, OpenClaw, Hermes, and Pi. It connects agents to an already-open
Chrome, Edge, or Electron session and provides live-page perception, Action
Receipts, CSS source tracing, session reports, replay, and Playwright export.
Validation remains source-bound to disposable fixtures and does not imply broad
adoption or six-host live testing.
```

## Submission checklist (human)

1. Verify the list’s contribution guide immediately before acting.
2. Use existing issue #1157; do not open a resource recommendation PR.
3. Link the stable v2.15.0 release and current README.
4. Avoid over-claiming benchmarks; point at the explicit evidence boundary.
5. Treat the Codex host manifest, 60-second safe demo, and fresh evidence baseline as prerequisites.

## Out of scope for agents

- Opening external PRs or posting issue comments without user confirmation
- Spamming multiple lists in one day
- Claiming npm registry install as the primary path (this project publishes via GitHub Releases)
