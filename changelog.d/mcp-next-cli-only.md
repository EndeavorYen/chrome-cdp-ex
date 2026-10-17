### Bug Fixes

* The MCP structured `next` is the CLI's own `Next:` command. A failed result uses the last line that starts with `Next: cdp`, and any other result uses the first, so a label, dialog, tree, diff, or error message that quotes `Next: cdp` does not supply it. A `Frames:` hint and a `Body truncated.` hint keep theirs ([#752](https://github.com/EndeavorYen/chrome-cdp-ex/issues/752)).
