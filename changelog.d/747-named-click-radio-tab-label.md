### Features

* A named `click` or `jsclick`, including `text=`, also matches a tab, a radio, and a label, such as an antd Segmented item. Nested candidates with the same name keep the innermost one, and a label that wraps or points at a disabled control is disabled. A word that is a CSS selector, such as `button`, stays a selector ([#747](https://github.com/EndeavorYen/chrome-cdp-ex/issues/747)).
