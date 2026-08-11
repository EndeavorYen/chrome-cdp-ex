# Awesome-list and directory outreach research

Status: research note only. **Do not auto-submit external PRs** from agents without explicit human approval.

Phase status: **Phase 0 evidence prerequisite complete locally**. Before any Phase 1 submission, refresh [the Codex for OSS evidence baseline](codex-for-oss-evidence.md), verify the destination's current contribution rules, and request explicit approval for each external post or pull request.

## Product one-liner (draft)

> **chrome-cdp-ex** — give coding agents eyes and hands on your *already open* Chrome/Edge/Electron session via CDP: perceive layout, act with receipts, recover from overlays/stale refs, and hand off reports. Zero npm runtime deps, Node 22+.

## Candidate targets

| Target | Why relevant | Notes / eligibility |
|---|---|---|
| [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) (and forks) | Already curated; description is stale at 68 commands / Claude-only positioning | Phase 1: propose a narrow cross-agent description refresh after explicit approval |
| Awesome Codex Skills lists | Codex CLI-skill route is now live-validated | Phase 1: submit only to an active, relevant list with the Codex Killer Path proof |
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

## Draft PR blurb

```markdown
### chrome-cdp-ex

Give AI coding agents access to your **live** Chrome/Edge/Electron tabs (login state, cookies, open pages) through a zero-dependency CDP CLI + optional MCP server.

- Perceive layout/refs/console without screenshot-first workflows
- Mutating actions return Action Receipts (dispatch, settlement, outcome, recovery)
- Doctor readiness, responsive audit, multi-tab groups, React/Vue components MVP

Repo: https://github.com/EndeavorYen/chrome-cdp-ex
```

## Submission checklist (human)

1. Verify the list’s contribution guide and section headings.
2. Confirm license/badge requirements.
3. Use a fresh branch against the *list* repo; do not force-push.
4. Link a release or README section that stays stable (`v2.9.x` or main docs).
5. Avoid over-claiming benchmarks; point at the live gate docs.
6. Treat the Codex host manifest, 60-second safe demo, and fresh evidence baseline as submission prerequisites.

## Out of scope for agents

- Opening external PRs without user confirmation
- Spamming multiple lists in one day
- Claiming npm registry install as the primary path (this project publishes via GitHub Releases)
