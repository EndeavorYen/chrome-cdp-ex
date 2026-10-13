### Features

* A named click that misses in the top frame checks accessible names in same-origin frames, and in a cross-site frame only when that frame is already attached. Exactly one matching frame points Next at `perceive <target> --frame @fN`, or at `click <target> @fN:M` when that frame-local ref is already known. No match or several matches keep the frame Next. `@fN` numbers stay put, `chrome-cdp-ex.frames.v1` is unchanged, and the cross-site read stays out of `text` and `summary` ([#718](https://github.com/EndeavorYen/chrome-cdp-ex/issues/718)).
