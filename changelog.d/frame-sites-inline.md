### Features

* Implicit `perceive` and `summary` inline an allowlisted cross-site frame under its host line, inside a `FRAME CONTENT` block, with the same `@fN:M` refs as `perceive --frame`. The read checks the committed origin before and after, stays on that frame, and stops at 8 frames. A frame that navigates or is past the cap is skipped with `navigated` or `cap` ([#638](https://github.com/EndeavorYen/chrome-cdp-ex/issues/638)).

### Bug Fixes

* `perceive --diff` and an action settle ignore the nonce on `FRAME CONTENT` markers, so an unchanged inlined frame is not a page change. The Frames line omits `perceive --frame` only when that frame's block is in the printed tree, and a depth limit or the chrome line cap that drops the block keeps the hint ([#638](https://github.com/EndeavorYen/chrome-cdp-ex/issues/638)).
