### Bug Fixes

* A CSS-selector or `@ref` click, an `elshot` by `@ref`, and a `drag` receipt name the target by `aria-label`, then its visible text, then `title`, with whitespace collapsed. An antd option whose `title` is the literal `[object Object]` is now named by its text (`Clicked <DIV> "B200 192 GB"`), and an icon button keeps its `title` over `aria-hidden` icon text ([#745](https://github.com/EndeavorYen/chrome-cdp-ex/issues/745)).
