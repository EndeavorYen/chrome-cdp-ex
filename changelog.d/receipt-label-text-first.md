### Bug Fixes

* A click, `elshot`, or `drag` receipt names its target by `aria-label`, then its text, then `title`, with whitespace collapsed. An antd option whose `title` is the literal `[object Object]` is now named by its text (`Clicked <DIV> "B200 192 GB"`) ([#745](https://github.com/EndeavorYen/chrome-cdp-ex/issues/745)).
