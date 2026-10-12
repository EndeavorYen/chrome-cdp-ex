### Bug Fixes

* `click` and `jsclick` treat a change to the clicked control's own `aria-pressed`, `aria-expanded`, `aria-checked`, or `aria-selected` as a reaction. The command exits 0 and the one-line receipt names the change (`aria-pressed false → true`). The accessibility line also shows `pressed` and `expanded`, next to the existing `checked` and `selected` tokens. A click that changes nothing still exits 1 with `Kind: click-no-change` ([#664](https://github.com/EndeavorYen/chrome-cdp-ex/issues/664)).
