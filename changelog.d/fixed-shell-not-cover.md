### Bug Fixes

* `overlay` and a covered click no longer treat a full-viewport fixed app shell that contains the target as the cover, so Next is not `dismiss-modal` against that shell. The cover is the element over the hit point that does not contain the target, including an absolutely positioned popover; a real opaque full-screen cover is unchanged ([#629](https://github.com/EndeavorYen/chrome-cdp-ex/issues/629)).
