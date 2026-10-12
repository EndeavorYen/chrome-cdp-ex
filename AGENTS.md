# AGENTS.md — chrome-cdp-ex

This is the only instruction file for agents working on this repository.

chrome-cdp-ex lets an agent use the user's running Chrome (or an Electron app) through the Chrome DevTools Protocol: the same tabs, cookies, and logins. Node.js 22+, zero runtime dependencies.

## Layout

| Path | What |
|---|---|
| `skills/chrome-cdp-ex/scripts/cdp.mjs` | Entry point only: runs `main` when executed and re-exports `executeCdpCli` and `__test__`. |
| `skills/chrome-cdp-ex/scripts/lib/cdp-*.mjs` | The runtime, split out of `cdp.mjs`: `cdp-base` (constants and pure helpers; imports no other `cdp-*` module), `cdp-core` (daemon lifecycle, tab environment, console buffers), `cdp-browser` (browser discovery, targets, tab groups), `cdp-page` (screenshots, diff-shot, nav), `cdp-action-result` (action outcome and diagnosis), `cdp-session-report` (status, summary, QA, reports, record export), `cdp-perceive` (refs and perceive), `cdp-input` (click, press, scroll, hover, drag, fill, select), `cdp-page-commands` (components, cookies, netlog, mock, upload, text, table), `cdp-flow` (inject, record, cascade, batch, flow, replay), `cdp-doctor` (doctor, spawn-debug-browser, overlay), `cdp-daemon` (`runDaemon` and the daemon server), `cdp-cli` (help, argument parsing, CLI errors, open), `cdp-main` (`main`, `executeCdpCli`). `cdp-domains` and `cdp-session` are the older CDP transport helpers. Commands are `<name>Str(cdp, sid, ...)` functions registered in `COMMANDS`. |
| `skills/chrome-cdp-ex/scripts/lib/` (other files) | Focused helpers: recovery, receipts, perception model, MCP adapter, `command-surface.mjs` (command catalog). |
| `skills/chrome-cdp-ex/scripts/mcp-server.mjs` | stdio MCP server; maps tools to the same CLI commands. |
| `skills/chrome-cdp-ex/SKILL.md` | Always-loaded agent card. Exhaustive command docs: `skills/chrome-cdp-ex/references/`, `docs/reference.md`. |
| `tests/` | Vitest. `scripts/live-smoke.mjs` drives a real browser. |
| `changelog.d/` | Unreleased changelog fragments. |

## Product goals

Order when they conflict: effective > easy for agents > efficient.

- **Effective:** never report a false success. A covered click is refused; a click that changes nothing is `no-change`. Claim only what was observed, and do not cause side effects on the user's page that the receipt does not report.
- **Easy for agents:** a successful action prints a one-line receipt. Every error names the cause and one executable `Next:` command. Do not rename, reorder, or drop an output field without a versioned schema change.
- **Efficient:** concise default output; bulk or sensitive detail only behind `--verbose`, `--full`, or `--unsafe-full`. A change to perceive, act, or output format reports before/after `agentChars` and `wallMs` from `npm run benchmark:slice1` (a measurement, not a gate).

## What to work on

- Fix what the user's agents hit in real use first. A self-found edge case goes to the backlog unless it causes a false success.
- Pick issues by label: `priority: p1`, then `p2`, then `p3`. An issue labeled `needs design` gets `/git-plan-issue` first, not code.
- Before writing code, reproduce the issue on current `origin/main`. If it no longer reproduces, comment with what you ran and close it.
- One issue per PR. Keep the diff small. At most 2 of your PRs open at once.
- Do not add process: no new fixtures that every PR must update, digests, inventories, benchmark harnesses, or tests that check doc wording.

## Code

- Pure ESM, Node built-ins only in shipped code.
- The `cdp-*` modules import each other in cycles. At module top level, do not read a binding from another `cdp-*` module; put shared constants in `cdp-base`. `tests/core-runtime-modules.test.mjs` loads each module on its own to catch this.
- A public surface change updates, in the same PR: `command-surface.mjs`, help text, `SKILL.md` or `references/commands.md`, and the MCP mapping when the command is an MCP tool. `npm run check:docs` checks that every command is documented.
- Redact secrets by default. Mutating commands return an action receipt with recovery guidance.

## Tests

- Test files are flat in `tests/` and named `<area>-<topic>.test.mjs`. Areas: `browser`, `daemon`, `core`, `cli`, `perceive`, `input`, `action`, `page`, `flow`, `report`, `mcp`, `table`, `tooling`. Find the file with `ls tests/<area>-*`.
- Red before green: add the failing case first, in the existing file for that behavior. Create a new file only for a new topic. Do not name files after issue numbers, and do not add to `legacy-*.test.mjs` (old mixed batches; move a case out when you touch it).
- Command-function tests use the shared fake client in `tests/mock-cdp.mjs`. Runtime source text, when a test must read it, comes from `tests/runtime-source.mjs`.
- Test behavior, not source layout: no line numbers, digests, inventories, or checks that a named function calls another. A source scan is fine only when it guards a product property (for example, every `Next:` command is runnable through MCP).
- A test that needs a browser uses `describe.skipIf(!browser)`; the unit suite must pass with no browser installed.
- Keep `npm test` fast. On a small machine, use `npm test -- --maxWorkers=2` or run the touched files with `npx vitest run <files>`; CI runs the full suite.

## Verify before pushing

```bash
npm test
npm run lint
npm run check:docs
```

CI also runs Windows and `smoke:live` on pinned Chrome stable. Run `npm run smoke:live` locally only when attach, perceive, or act code changed and a browser is installed.

## Commits and PRs

- Branch from `origin/main`, rebase on `origin/main` before pushing, and target `EndeavorYen/chrome-cdp-ex:main`.
- Git identity must be the GitHub noreply address. Never put a company name, email, hostname, local path, or `Co-authored-by` line in a commit, PR, or comment. This repository is public.
- Changelog: one `changelog.d/<slug>.md` per PR, with a `###` heading from `CHANGELOG.md` and one or two sentences per bullet.
- PR body, short:

  ```
  Closes #N

  ## Summary
  - what changed and why (1-3 bullets)
  - goals: effective / easy / efficient impact in one line

  ## Verification
  - `<command>` → <result>
  ```

  Do not paste CI links, evidence classes, mutation lists, or review transcripts; the PR page shows CI.
- Review with `/git-review-pr-force <PR>`, then merge with `/git-merge-approved-force <PR>`: squash on the exact head, with an explicit subject and body.

## Release

Bump `package.json` and `.claude-plugin/plugin.json` together, run `npm run changelog:fold`, move the folded notes under the new version heading in `CHANGELOG.md`, update the release link in `README.md`, then tag `v<version>`. Releases go to GitHub Releases, not npm.
