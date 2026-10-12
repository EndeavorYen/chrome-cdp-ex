# Attach and health

## Sub-features

doctor, list, open, stop. From Chrome 136, the default profile does not enable CDP.

## How to get to it (user POV)

The first command is `bin/chrome-cdp doctor`, then `list` or `open <url>`.

## Driving it with drive-once.sh

`CDP_PORT=9444 ./bin/chrome-cdp doctor`, then `open http://127.0.0.1:41744/page.html` (the `CDP_VERIFY_PORT` and `CDP_VERIFY_HTTP_PORT` defaults).

Proof: doctor exits 0 and prints the Chrome version; open prints `Opened new tab: <id>`.

## Gotchas

`file://` is refused (exit 1 and a Next line). If the port is already in use, do not attach to it.
