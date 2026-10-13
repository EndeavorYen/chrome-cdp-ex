### Bug Fixes

* `perceive --diff` and `perceive --since-action` list a node replaced by another node with the same text as removed and added. The added line shows the new `@ref`. The old `@ref` stays stale. An action receipt still treats such a redraw as no change, so a click that only redraws identical content still exits 1 with `Kind: click-no-change` ([#651](https://github.com/EndeavorYen/chrome-cdp-ex/issues/651)).
