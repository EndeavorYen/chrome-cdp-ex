### Bug Fixes

* `click` treats a visible label such as `Save profile` as text, in any script, and keeps real selectors (`#form #delete`, `div span`, `nav a`). A label click, including `text=`, hit-tests and refuses with `Kind: covered` when another element is on top. An unclosed quote in the target is an error ([#641](https://github.com/EndeavorYen/chrome-cdp-ex/issues/641)).
