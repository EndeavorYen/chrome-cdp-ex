### Bug Fixes

* `upload` no longer fails with `Kind: unknown` when the page reads the file in its change handler and then clears the input. When the input held exactly the files sent at its first `input` or `change` event, the receipt succeeds and ends with `(the page cleared the input after its change event)` ([#743](https://github.com/EndeavorYen/chrome-cdp-ex/issues/743)).
