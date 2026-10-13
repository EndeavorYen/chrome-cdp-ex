### Bug Fixes

* A directional `scroll` with an open dialog and a scroll-locked background moves the dialog's overflow container instead of the locked page's main scroller. A modal dialog (`aria-modal` or `:modal`) is preferred the same way. On a document that is already at the bottom or top, `scroll down` or `scroll up` says so (`at-bottom: yes` / `at-top: yes`) instead of `Scrolled by (0, 500)` ([#657](https://github.com/EndeavorYen/chrome-cdp-ex/issues/657)).
