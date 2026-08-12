# Validation regression seeds

This directory is a review queue, not an executable registry. `validation-lab
promote` may write one explicitly named, redacted seed here only after a human
confirms a repeatable product failure. It never edits tests, the scenario
registry, issues, or documentation.

To adopt a seed:

1. reproduce it with the seed's exact replay command;
2. turn the smallest stable behavior into a focused failing test;
3. review the test and the product fix separately; and
4. separately decide whether the scenario belongs in `scenarios.v1.json`.

Do not commit evidence bundles, credentials, browser profiles, authenticated
page state, or machine-specific paths here.
