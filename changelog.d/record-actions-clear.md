### Bug Fixes

* `record-actions <target> --clear` empties that tab's action log and recorded environment steps in the running daemon and in `cdp-<targetId>.observe.json`, and keeps the netlog buffer. `stop`, an idle exit, a crash, and `kill -9` still keep the log; `closetab` still removes the file ([#744](https://github.com/EndeavorYen/chrome-cdp-ex/issues/744)).
