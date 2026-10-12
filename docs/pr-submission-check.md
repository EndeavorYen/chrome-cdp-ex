# PR submission check

`.github/workflows/pr-submission-check.yml` runs `scripts/check-pr-submission.mjs` on pull requests to `main` and `dev` when a pull request is opened, edited, synchronized, reopened, or marked ready for review. The command prints `OK` when every rule passes. It prints one `FAIL <rule>: <detail>` line per problem and exits `1` when a rule fails. A bad command line exits `2`.

## Verification

The body needs a `## Verification` heading. From that heading until the next `## ` heading, or the end of the body, the text must include `Proof` and `Evidence class`. Matching ignores case. A `###` subsection stays inside the section.

## Forbidden text

The body and each commit message are scanned for local filesystem paths:

- `/home/<name>/` followed by more path
- `/Users/<name>/` followed by more path
- `/root/` followed by more path
- `/workspace/` followed by more path
- `C:\Users\<name>\` followed by more path
- `~/` followed by a segment

The built-in list is only those path shapes. Additional forbidden substrings come from the repository variable `PR_FORBIDDEN_TERMS`. The workflow passes that variable to the checker as the environment variable of the same name. See [Setting PR_FORBIDDEN_TERMS](#setting-pr_forbidden_terms) for how to set the variable and how terms match.

Keep those terms in the repository variable so internal names stay out of the tree.

## Setting PR_FORBIDDEN_TERMS

`PR_FORBIDDEN_TERMS` is a repository variable, not a secret. The workflow reads it through `vars.PR_FORBIDDEN_TERMS`.

In the repository, open Settings > Secrets and variables > Actions. On the Variables tab, choose New repository variable and name it `PR_FORBIDDEN_TERMS`.

Or set it from a file:

```bash
gh variable set PR_FORBIDDEN_TERMS -R <owner>/<repo> --body "$(cat terms.txt)"
```

Separate terms with newlines or commas. Whitespace around each term is trimmed. Blank entries are ignored. A term matches as a case-insensitive substring of the pull request body and of every commit message.

Example `terms.txt`, using placeholder terms only:

```
example-codename
internal-project-x, staging-hostname
```

The variable takes effect on the next pull request event.

## Co-author trailers

A line that starts with `Co-authored-by:` is rejected when its value matches `bot`, `agent`, `cursor`, `copilot`, or `[bot]`, ignoring case. The failure names the zero-based commit index and the one-based line in that commit message.

## Head SHA

One rule: any SHA inside code markup is never checked. Code markup is an inline code span of any backtick length, or a fenced block opened with `` ``` `` or `~~~`. Only a plain-prose citation is checked, such as `Verified on head sha abc1234` or `head: abc1234`.

A hex token of 7 to 40 characters is a head citation when it follows the word `head` in that prose. The word may be followed by `sha` or `commit`, then an optional colon and whitespace. Each token must be a prefix of the current head SHA, ignoring case. A body with no prose citation passes. A mismatch reports `body cites head X but current head is Y`.

Citing another pull request's head, or an older head of this pull request, must be written in code markup, for example In #690 (head `37bdbe0`). The current head may be cited in prose.

## Local usage

```bash
printf '%s' "$PR_BODY" > body.md
git log --format='%B%n---commit---' "$BASE..$HEAD" > commits.txt
PR_FORBIDDEN_TERMS="$PR_FORBIDDEN_TERMS" node scripts/check-pr-submission.mjs \
  --body-file body.md \
  --head "$HEAD" \
  --commits-file commits.txt
```

`--commits-file` is optional. Commit messages in that file are separated by a line that is exactly `---commit---`.

The workflow checks out full history, sets up Node 22, writes the body from `PR_BODY` with `printf '%s'`, and does not install packages.
