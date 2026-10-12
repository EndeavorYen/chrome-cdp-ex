# CI test shards

The Linux `test` job runs the suite as three parallel shards. `fail-fast` is false, so one shard does not cancel the others. The matrix is `shard: [1, 2, 3]`. The job name is `test (shard N/3)`. Each shard runs:

```bash
npm test -- --shard=N/3
```

`test-windows`, `lint`, `docs`, and `coverage` are unchanged. `coverage` still runs the full suite in one job.

## Quarantine

`tests/quarantine.mjs` exports `QUARANTINE` and `quarantined(issue)`.

`quarantined(issue)` is true when `CI` is truthy and `CDP_RUN_QUARANTINED` is not `1`. The quarantine also applies to `test-windows` and `coverage` (both set `CI`), so listed tests skip there as well as on the Linux shards. The non-blocking `test-quarantined` job runs on both Linux and Windows (`ubuntu-latest` and `windows-latest`, `fail-fast: false`, `continue-on-error: true`). It runs only the quarantined files with `CDP_RUN_QUARANTINED=1`. On Windows it uses Git Bash and `--maxWorkers=2`, matching `test-windows`. #687 was seen on `windows-latest`. A flake stays visible and does not fail the workflow.

Each entry is `{ issue, file, test }`. `issue` is an open issue that tracks the flake.

To quarantine a test:

1. Add an `{ issue, file, test }` entry to `QUARANTINE`. Reference an open issue.
2. Change that test from `it(...)` to `it.skipIf(quarantined(<issue>))(...)`.
3. Leave the correctness tests in the same file running.

To unquarantine, remove the entry and the `skipIf` wrapper in the same change.

`tests/quarantine.test.mjs` checks that every entry's file exists and that the test-name string literal immediately after `skipIf(quarantined(<issue>))` equals that entry's `test` name, and that every `skipIf(quarantined(...))` call under `tests/*.test.mjs` is listed with the same issue and file. An entry whose name does not follow a matching call, or a call whose name is not listed, fails that test.

## Run a shard locally

```bash
CI=1 npm test -- --shard=1/3
```

`CI=1` skips quarantined tests, matching the Linux shards, `test-windows`, and `coverage`. Use `2/3` or `3/3` for the other shards. To run the quarantined files locally:

```bash
CDP_RUN_QUARANTINED=1 npm test -- tests/issue-503-quoted-secret-tail.test.mjs tests/issue-511-escaped-json-and-netlog-bodies.test.mjs tests/issue-518-linear-timing-helper.test.mjs
```
