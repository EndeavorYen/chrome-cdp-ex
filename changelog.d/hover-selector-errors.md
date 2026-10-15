### Bug Fixes

* `hover` failures that are not a delivery miss now name a `Kind` and a runnable `Next:` instead of `Kind: unknown`. `hover "text=…"` says hover takes a CSS selector or an `@ref` (`Kind: usage`), an invalid selector prints `Invalid selector: …` without a browser stack (`Kind: invalid-selector`), and a miss is `Kind: selector`, each with `Next: cdp perceive <target> -C -d 8` ([#750](https://github.com/EndeavorYen/chrome-cdp-ex/issues/750)).
