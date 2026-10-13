### Bug Fixes

* Rewriting a `batch` step to absolutize a shot or upload path keeps a value that contains `'`, such as `O'Brien` or `it's a note`, as one argument. A value that contains both `'` and `"`, such as `"O'Brien"`, is no longer wrapped in backticks, which `batch` would store as part of the value. When neither quote `batch` understands can wrap it, that step is left unchanged. `flow` still uses backticks for that value ([#615](https://github.com/EndeavorYen/chrome-cdp-ex/issues/615), [#617](https://github.com/EndeavorYen/chrome-cdp-ex/issues/617)).
