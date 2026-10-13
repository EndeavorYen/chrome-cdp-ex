### Features

* `click`, `fill`, `jsclick`, and `select` on a ref inside a cross-site frame (`@fN:M`, `process:oopif`) run in that frame's child session. The click point is translated to page coordinates with the owner iframe's box, and a cover in the page or in the frame is `Kind: covered`. Other actions on those refs still fail as `Kind: usage` with Next `cdp frame <target>`. Same-origin `@fN` numbers and `chrome-cdp-ex.frames.v1` stay the same ([#717](https://github.com/EndeavorYen/chrome-cdp-ex/issues/717)).
