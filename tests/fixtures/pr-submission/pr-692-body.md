Refs #691

## Summary
- `scripts/check-pr-submission.mjs`: pure checks + CLI (`--body-file F --head SHA [--commits-file F]`; prints `OK` or `FAIL <rule>: <detail>`; exit 1 on a problem, 2 on usage error).
  - verification: `## Verification` present and contains `Proof` and `Evidence class`.
  - forbidden-text: local filesystem paths (home/user dirs, `/root`, `/workspace`, Windows user dirs, `~/…`) and any term from the `PR_FORBIDDEN_TERMS` repository variable, in the body and in every commit message. No denylisted terms are stored in the repo.
  - co-author: `Co-authored-by:` trailers matching bot/agent/cursor/copilot/`[bot]`.
  - head-sha: a hex token after `head` / `head sha` / `head commit` must be a prefix of the current PR head.
- `.github/workflows/pr-submission-check.yml`: runs on opened/edited/synchronize/reopened/ready_for_review; the body is passed through an env var and written with `printf`, never interpolated into the script.
- `docs/pr-submission-check.md`, `tests/pr-submission-check.test.mjs` (22 tests).

Follow-up for a maintainer: set the `PR_FORBIDDEN_TERMS` repository variable; until then only the path patterns apply.

## Verification
Evidence class: E2 (author reran the commands; CI result below).

Proof (local, Linux x86_64, Node 22, no browser involved):
- `npx vitest run tests/pr-submission-check.test.mjs` → 22 passed / 22, 1 run.
- `npm run lint` → 0 errors (1 pre-existing warning in tests/cdp.test.mjs, untouched).
- Checker against the body of #690 with its real head → `OK`, exit 0; same body with head `1111…` → `FAIL head-sha: body cites head 37bdbe0 but current head is 1111…`, exit 1.
- This PR body cites head sha c2621dc, so the job on this PR also exercises the head-sha rule.
- CI: see checks on this PR (job `pr-submission-check`, ubuntu-latest); run link added once complete.

Mutation checks (local, Node 22, 1 run each; each check function body replaced with `return [];`):
1. checkVerification → 4 failed / 22.
2. checkForbiddenText → 5 failed / 22.
3. checkCoAuthors → 2 failed / 22.
4. checkHeadSha → 1 failed / 22.

