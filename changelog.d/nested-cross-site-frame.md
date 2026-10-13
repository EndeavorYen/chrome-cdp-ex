### Bug Fixes

* `perceive --frame` on a same-process frame nested inside a cross-site frame reads that frame through the parent frame's child session. `click`, `fill`, `jsclick`, and `select` on its `@fN:M` refs use the same session ([#729](https://github.com/EndeavorYen/chrome-cdp-ex/issues/729)).
