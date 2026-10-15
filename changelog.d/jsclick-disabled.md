### Bug Fixes

* A JS click (`jsclick`, `click --js`, and `click` or `jsclick` by name such as `"text=Exec"`) on a control with the `disabled` attribute or inside a disabled `<fieldset>` now fails with `Kind: disabled` and exit 1. It used to print `JS-clicked …` with exit 0 for a name, or `Kind: click-no-change` for a selector, although the browser fires no click on such a control; `aria-disabled="true"` is still clicked ([#742](https://github.com/EndeavorYen/chrome-cdp-ex/issues/742)).
