### Bug Fixes

* A `fill` or `select` miss on a page with frames ends the wait note with a period before the frame sentence, so it reads `(waited 2001ms for attach). The page has 1 frame and the control may be inside one.` ([#715](https://github.com/EndeavorYen/chrome-cdp-ex/issues/715)).
