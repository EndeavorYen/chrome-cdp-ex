# Codex for OSS evidence baseline

Status: internal application evidence, measured 2026-08-12 (Asia/Taipei). Do not submit, publish outreach, or turn these counts into adoption claims without a fresh review.

Application: [Codex for Open Source](https://openai.com/form/codex-for-oss/). OpenAI says it reviews active open-source projects for meaningful usage, broad adoption, or clear ecosystem importance, alongside evidence of active maintenance. It does not publish a minimum star threshold.

## Current measured facts

| Signal | 2026-08-12 measurement | Claim boundary |
|---|---:|---|
| Repository | [EndeavorYen/chrome-cdp-ex](https://github.com/EndeavorYen/chrome-cdp-ex) | Public MIT project; GitHub Releases are the official distribution surface |
| GitHub interest | 12 stars, 0 forks | Small direct audience; do not imply broad adoption |
| Maintenance history | 84 issues, 53 pull requests | Repository-wide closed + open totals, not current backlog |
| Releases | 17 releases | Release cadence, not install count |
| Release assets | 18 cumulative release-asset downloads | GitHub asset counter only; excludes source archives and clones |
| Current release asset | 6 downloads for `v2.14.0` | Not unique users and not monthly downloads |
| External contribution | [PR #125](https://github.com/EndeavorYen/chrome-cdp-ex/pull/125), merged from `hussainweb` | One verified external merged pull request |
| 14-day traffic | 70 views / 40 unique visitors | Maintainer-only GitHub traffic window; refresh before use |
| 14-day clones | 73 clones / 49 unique cloners | Clone events are not installs or retained users |
| GitHub code search | 22 GitHub code-search references | Most results are mirrors or indexes; this is discoverability, not adoption |

## Ecosystem recognition

`chrome-cdp-ex` is currently curated in [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) under “Providers, Runtime & Integration Infrastructure.” On 2026-08-12 that index had 52,132 stars and 4,555 forks.

The listing calls the project rigorous about its claims and mentions the dogfood benchmark gate. It still describes the older “Claude Code skill (68 commands)” shape, while v2.14.0 is an 81-command cross-host runtime. The list's popularity belongs to the list, not to this repository; it is third-party curation evidence, not a `chrome-cdp-ex` star or usage count.

The 22 code-search references break down mostly into Awesome-list mirrors, trackers, and indexes. A few independent references exist, but the aggregate must not be described as 22 downstream users.

## Current technical proof

- v2.14.0 passed a fresh 10/10-round mixed campaign on 2026-08-12: MCP, CLI, Killer Path, 5,200-node large-app stress, and five safe local real-app profiles.
- Each of the five real-app rounds passed 34/34 gates.
- The Codex CLI-skill route is `live-validated` against one disposable local fixture: install, doctor, perceive, act, Action Receipt, `since-action`, and report.
- Claude Code, Cursor, OpenClaw, Hermes, and Pi remain documented routes; Phase 0 does not claim they were live-tested.

These measurements prove maintenance discipline and current runtime behavior. They do not prove production adoption.

## Application framing

The strongest honest case is not “this repo already has hundreds of users.” It is:

1. a primary maintainer actively maintains a cross-agent browser perception and action-evidence runtime;
2. the project has repeated release, issue-triage, review, benchmark, and documentation work that matches the maintenance workflows Codex for OSS is intended to support;
3. a major community index independently curated it with positive editorial language;
4. Codex is a first-class validated host rather than a branding-only mention; and
5. the project uses fail-closed benchmark gates to keep public claims evidence-bound.

The main application weakness remains direct usage. Twelve stars and 18 asset downloads are modest. Anecdotes about successful applicants at 100–200 stars are not an official eligibility rule, and acquiring low-intent stars would not establish meaningful usage. Phase 1 promotion should seek qualified users, reproducible feedback, and independent workflow evidence.

## Refresh commands

Run these immediately before drafting or submitting an application. They print aggregate values only; never commit credentials or raw private traffic payloads.

```bash
gh api repos/EndeavorYen/chrome-cdp-ex --jq '{stars:.stargazers_count,forks:.forks_count,updated_at,pushed_at}'
gh api --paginate 'repos/EndeavorYen/chrome-cdp-ex/releases?per_page=100' --jq '.[] | [.tag_name, ([.assets[].download_count] | add // 0)] | @tsv'
gh api --method GET search/issues -f q='repo:EndeavorYen/chrome-cdp-ex is:issue' --jq '{total_count}'
gh api --method GET search/issues -f q='repo:EndeavorYen/chrome-cdp-ex is:pr' --jq '{total_count}'
gh api repos/EndeavorYen/chrome-cdp-ex/traffic/views --jq '{count,uniques}'
gh api repos/EndeavorYen/chrome-cdp-ex/traffic/clones --jq '{count,uniques}'
gh api repos/EndeavorYen/chrome-cdp-ex/pulls/125 --jq '{merged,merged_at,author:.user.login,html_url}'
gh api --method GET search/code -f q='"github.com/EndeavorYen/chrome-cdp-ex"' --jq '{total_count}'
gh api repos/hesreallyhim/awesome-claude-code --jq '{stars:.stargazers_count,forks:.forks_count,updated_at}'
```

## Phase 0 handoff

Phase 0 prepares evidence but performs no external action. Any application submission, Awesome-list update, community post, release, commit, push, or pull request still requires an explicit separate decision.
