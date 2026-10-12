# Act and receipts

## Sub-features

click, fill, press, select, scroll. Failure kinds: covered, misdirected, click-no-change, disabled.

## How to get to it (user POV)

`click <t> <sel|@ref>`, then read the one-line receipt.

## Driving it with drive-once.sh

Proof: the receipt contains `aria-pressed false → true`, and `eval` reads the page state `clicked true` (check the side effect, not only the receipt).

## Gotchas

Exit 0 means the page reacted. Do not `eval` a state change and call it a click.
