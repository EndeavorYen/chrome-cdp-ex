### Bug Fixes

* Pull requests can merge in parallel. New changelog notes live in `changelog.d/<slug>.md` until `npm run changelog:fold` copies them into `## [Unreleased]` before a tag. The current runtime-dispatch fixture records commands, owners, and digests, and it omits source line numbers, so a line move leaves that file unchanged ([#695](https://github.com/EndeavorYen/chrome-cdp-ex/issues/695)).
