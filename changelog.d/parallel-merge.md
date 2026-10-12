### Bug Fixes

* Pull requests can merge in parallel. New changelog notes live in `changelog.d/<slug>.md` until `npm run changelog:fold` copies them into `## [Unreleased]` before a tag ([#695](https://github.com/EndeavorYen/chrome-cdp-ex/issues/695)).
