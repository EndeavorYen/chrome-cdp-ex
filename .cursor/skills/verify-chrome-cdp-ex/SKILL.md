---
name: verify-chrome-cdp-ex
description: Verify chrome-cdp-ex (CLI and MCP driving a real Chrome). Use when proving a fix, or when a reviewer re-runs the user path on a PR head.
---

# verify-chrome-cdp-ex

Node.js 22+. Chrome is `${CHROME_BIN:-google-chrome}`.

Helper: `.cursor/skills/verify-chrome-cdp-ex/helpers/drive-once.sh`.

## Setup

- Save local work on a branch before `git fetch origin` and `git reset --hard` onto the commit under test.
- Run `npm ci` only when `node_modules` is missing or the lockfile changed.

## Launch / Teardown

- Unit tests do not need a browser.
- `.cursor/skills/verify-chrome-cdp-ex/helpers/drive-once.sh [repo] [evidence-dir]` starts an isolated headless Chrome (`CDP_VERIFY_PORT`, default 9444, temporary profile) and a local http server (`CDP_VERIFY_HTTP_PORT`, default 41744), then tears both down. `repo` defaults to `git rev-parse --show-toplevel`. `CDP_VERIFY_NO_ONCLICK=1` writes the page button without the `onclick` attribute (reverse check: the click fails with `click-no-change` and `CDP_VERIFY_NO_ONCLICK=1 drive-once.sh` exits non-zero).
- Ready when `curl -s http://127.0.0.1:9444/json/version` responds. Use the port you set.
- The script sets `CDP_ISOLATED_ONLY=1`. Do not attach to a daily browser. If the port is taken, change `CDP_VERIFY_PORT`.

## Doctor

Read-only. Run this first when something looks wrong.

`CDP_PORT=9444 ./bin/chrome-cdp doctor` exits 0 and prints `CDP: 127.0.0.1:9444 → Chrome/<version>`. Pass the same port as `CDP_VERIFY_PORT`.

## Test steps

| Step | Command | Pass condition |
|---|---|---|
| Unit tests | `npm test` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Docs contract | `npm run check:docs` | exit 0 and prints `Docs contract OK` |
| Changelog fragments | `npm run check:changelog` | exit 0 |
| Live smoke | `npm run smoke:live` | exit 0 and no `FAIL` line |
| User path | `.cursor/skills/verify-chrome-cdp-ex/helpers/drive-once.sh` | `drive-once.sh` exits 0 |

`AGENTS.md` "Verify before pushing" is the gate: `npm test`, `npm run lint`, `npm run check:docs`. `npm run check:docs` already checks changelog fragments. On a small machine, `npm test -- --maxWorkers=2`. A single area can start with `npx vitest run tests/<area>-*.test.mjs`. CI also runs Windows and `smoke:live`. Run `npm run smoke:live` locally only when attach, perceive, or act code changed and a browser is installed.

## Drive (user path)

Real commands, in order. Do not `eval` a state change and call it a click.

`doctor` → `open http://…` → `perceive <t> -C -d 8` → `click <t> #b` → `eval` reads the result → `shot <t> <png>`.

Pass condition: the click receipt contains `Clicked <BUTTON> "Toggle me": aria-pressed false → true`, eval prints `clicked true`, and the screenshot is written under the evidence directory.

### Gotchas

- `open file://…` is refused on purpose (exit 1, `Kind: usage`). Next tells you to serve the folder over http.
- In background mode, a hidden-tab screenshot can return `Kind: hidden-tab`. Follow `Next:` and rerun only the screenshot.
- Exit 0 means the page reacted. `Kind: click-no-change` and `Kind: covered` are failures.

## Proving a fix

Reproduce red on `origin/main` with a regression test. On the branch, that test is green, then the full `npm test`, `npm run lint`, and `npm run check:docs` are green. When attach, perceive, or act code changed, also run `npm run smoke:live`. A reviewer re-runs those commands plus `.cursor/skills/verify-chrome-cdp-ex/helpers/drive-once.sh` on the PR head.

Source of truth: `AGENTS.md` section "Verify before pushing".

## Cleanup

The trap in `.cursor/skills/verify-chrome-cdp-ex/helpers/drive-once.sh` stops only the Chrome, http server, and daemon it started (`./bin/chrome-cdp stop` on its port), then deletes the temporary profile. It leaves the evidence directory. Do not `pkill` by process name.

Leftover check (use the ports you set):

```bash
pgrep -af 'remote-debugging-port=9444|http.server.*41744'
```

No output.

## Maintenance

Update this skill when a release is tagged; when `package.json` scripts, the `AGENTS.md` "Verify before pushing" block, `scripts/live-smoke.mjs`, or the Survivors list in `skills/chrome-cdp-ex/SKILL.md` change; or when someone follows this skill and it fails.

Drift checks (read-only):

1. Every `npm` script in the test-steps table exists in `package.json`.
2. The push gate above matches `AGENTS.md` "Verify before pushing".
3. Every command under `Sub-features` in `features/` is in the Survivors list in `skills/chrome-cdp-ex/SKILL.md`.
4. `.cursor/skills/verify-chrome-cdp-ex/helpers/drive-once.sh` exits 0. The reverse check `CDP_VERIFY_NO_ONCLICK=1 drive-once.sh` exits non-zero.

When the product and this map disagree, a stale doc is a map edit and a product regression is an issue. Do not hide a regression in the skill. The outcome is one of: clean, changed, blocked.
