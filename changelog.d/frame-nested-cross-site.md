### Bug Fixes

* `frame` lists a third-site iframe embedded in a cross-site frame after the other cross-site frames, with `parentRef` and `process:oopif`. Existing `@fN` numbers stay put. That child session auto-attaches lazily, the same way the page does, and a main-frame navigation or detach drops the cache ([#730](https://github.com/EndeavorYen/chrome-cdp-ex/issues/730)).
