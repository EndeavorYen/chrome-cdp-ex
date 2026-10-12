# CI test shards

The Linux `test` job runs the suite as three parallel shards. `fail-fast` is false, so one shard does not cancel the others. The matrix is `shard: [1, 2, 3]`. The job name is `test (shard N/3)`. Each shard runs:

```bash
npm test -- --shard=N/3
```

`test-windows`, `lint`, `docs`, and `coverage` are unchanged. `coverage` still runs the full suite in one job.

## Quarantine

`tests/quarantine.mjs` exports `QUARANTINE` and `quarantined(issue)`.

`quarantined(issue)` is true when `CI` is truthy and `CDP_RUN_QUARANTINED` is not `1`. The Linux shards run with `CI` set, so listed tests skip there. The `test-quarantined` job (`ubuntu-latest`, `continue-on-error: true`) runs only the quarantined files with `CDP_RUN_QUARANTINED=1`. A flake stays visible and does not fail the workflow.

Each entry is `{ issue, file, test }`. `issue` is an open issue that tracks the flake.

To quarantine a test:

1. Add an `{ issue, file, test }` entry to `QUARANTINE`. Reference an open issue.
2. Change that test from `it(...)` to `it.skipIf(quarantined(<issue>))(...)`.
3. Leave the correctness tests in the same file running.

To unquarantine, remove the entry and the `skipIf` wrapper in the same change.

`tests/quarantine.test.mjs` checks that every entry's file exists and contains `skipIf(quarantined(<issue>))`, and that the number of `skipIf(quarantined(...))` calls under `tests/*.test.mjs` equals `QUARANTINE.length`. A new skip without an entry, or an entry without a skip, fails that test.

## Run a shard locally

```bash
CI=1 npm test -- --shard=1/3
```

`CI=1` skips quarantined tests, matching the Linux shards. Use `2/3` or `3/3` for the other shards. To run the quarantined files locally:

```bash
CDP_RUN_QUARANTINED=1 npm test -- tests/issue-503-quoted-secret-tail.test.mjs tests/issue-511-escaped-json-and-netlog-bodies.test.mjs tests/issue-518-linear-timing-helper.test.mjs
```
