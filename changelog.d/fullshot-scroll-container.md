### Features

* `fullshot` captures a page that scrolls inside a fixed box. `--scroll-container` names that box (`<sel|@ref>`); with no flag, a document that does not scroll uses the same largest overflow container `scroll` already picks. The receipt names the container. A missing selector is `Kind: selector`; an element that does not scroll is `Kind: usage` ([#746](https://github.com/EndeavorYen/chrome-cdp-ex/issues/746)).
