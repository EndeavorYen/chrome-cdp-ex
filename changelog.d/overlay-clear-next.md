### Bug Fixes

* A clear `overlay` report no longer ends with `Next: continue`. When a selector or `@ref` was given and no dismissable blocker is named, Next is `cdp click <prefix> <sel> --js`, including after a covered click whose cover the detector does not list (an `opacity: 0` full-viewport layer). With no selector, Next is `cdp perceive <prefix> -C -d 8`. JSON `nextCommand` is that same command ([#630](https://github.com/EndeavorYen/chrome-cdp-ex/issues/630)).
