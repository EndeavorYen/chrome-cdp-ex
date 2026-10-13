### Bug Fixes

* `overlay` and `dismiss-modal` keep their shadow-root behavior under test: a fixed cover inside an open shadow root that the document hit reports only as its host, and a cover two open shadow roots deep, are both covered by tests now. A redundant host check in the containment walk is removed; results are unchanged ([#736](https://github.com/EndeavorYen/chrome-cdp-ex/issues/736)).
