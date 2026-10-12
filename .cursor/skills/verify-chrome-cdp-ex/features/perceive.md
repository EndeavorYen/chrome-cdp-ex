# Read the page

## Sub-features

perceive (`@ref`), `text --auto`, shot, elshot.

## How to get to it (user POV)

`perceive <t> -C -d 8` returns clickable controls and `@ref`s.

## Driving it with drive-once.sh

Proof: output includes a `button` line with `"Toggle me"` and `@1`. `shot` writes a png and prints `Screenshot saved`.

## Gotchas

A screenshot of a hidden tab may return `Kind: hidden-tab`. Follow Next and rerun only the screenshot.
