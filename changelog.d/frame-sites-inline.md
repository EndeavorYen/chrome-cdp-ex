### Features

* Implicit `perceive` and `summary` inline an allowlisted cross-site frame under its host line, inside a `FRAME CONTENT` block, with the same `@fN:M` refs as `perceive --frame`. The read checks the committed origin before and after, stays on that frame, and stops at 8 frames. A frame that navigates or is past the cap is skipped with `navigated` or `cap` ([#638](https://github.com/EndeavorYen/chrome-cdp-ex/issues/638)).

### Bug Fixes

* `perceive --diff` and an action settle ignore the nonce on `FRAME CONTENT` markers, so an unchanged inlined frame is not a page change. When that frame is the only one and its tree is already shown, the Frames line does not suggest `perceive --frame` ([#638](https://github.com/EndeavorYen/chrome-cdp-ex/issues/638)).
