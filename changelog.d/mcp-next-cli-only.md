### Bug Fixes

* The MCP structured `next` is the CLI's own `Next:` command. A control label, dialog message, perceive tree, diff, or error message that quotes `Next: cdp` no longer supplies it. A `Frames:` hint and a `Body truncated.` hint keep theirs ([#752](https://github.com/EndeavorYen/chrome-cdp-ex/issues/752)).
