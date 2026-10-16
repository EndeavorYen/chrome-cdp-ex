### Bug Fixes

* A covered `hover` now names the element on top by `aria-label`, then visible text, then `title`, as click, `elshot` and `drag` receipts do. An antd option whose `title` is `[object Object]` is named by its text, for example `It is covered by <DIV#opt> "B200 192 GB"` ([#757](https://github.com/EndeavorYen/chrome-cdp-ex/issues/757)).
