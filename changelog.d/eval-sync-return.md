### Bug Fixes

* `eval` accepts a top-level `return` in a script with or without `await`. `const a = 1; return a + 1` prints `2`, and a `return` inside a block prints that value. A script without `return` still returns its last expression and can run again. An async script whose final value cannot be inferred still asks for an explicit `return`, and that failure is `Kind: eval` with `Next: cdp help eval` ([#751](https://github.com/EndeavorYen/chrome-cdp-ex/issues/751)).
