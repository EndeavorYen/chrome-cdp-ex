### Bug Fixes

* An unclosed quote inside a `flow` `eval`, `eval64`, or `call` step now suggests a fix in that same command (for example `eval 'const x = 1; x'`) instead of a `fill` example. Other steps keep their examples ([#698](https://github.com/EndeavorYen/chrome-cdp-ex/issues/698)).
