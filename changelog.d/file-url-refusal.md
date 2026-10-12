### Bug Fixes

* `open` and `nav` still refuse a `file:` URL. The error says that refusal is on purpose (`Kind: usage`), and Next is `python -m http.server --protocol HTTP/1.1 --bind 127.0.0.1 8000` run in the file's folder, then `http://127.0.0.1:8000/<filename>` ([#587](https://github.com/EndeavorYen/chrome-cdp-ex/issues/587)).
