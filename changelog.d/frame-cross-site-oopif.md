### Features

* `frame` lists cross-site iframes after the same-origin `@fN` refs. Each added frame has `parentRef` and `process:oopif`. `chrome-cdp-ex.frames.v1` stays the same schema and `frameCount` now includes those frames. The page attaches iframe targets on the first `frame`, or when a cross-site `@fN` is resolved, and drops that cache on a main-frame navigation or `Target.detachedFromTarget`. `perceive --frame @fN` reads a cross-site frame's accessibility tree. `perceive` itself still does not attach ([#716](https://github.com/EndeavorYen/chrome-cdp-ex/issues/716)).

### Bug Fixes

* A depth-1 frame that is still `about:blank` or has an empty URL, with an opaque security origin (`://`, empty, or `null`), counts as cross-site in the `Frames:` line and in a selector-miss census while its iframe `src` points at another site. It is not a same-origin frame, it gets no ref, and Next does not point at it. `frame` still lists that frame as Chrome reports it, and same-origin `@fN` numbers stay put. An `about:blank` iframe with no `src`, a same-site `src`, or `srcdoc` stays same-origin ([#716](https://github.com/EndeavorYen/chrome-cdp-ex/issues/716)).
