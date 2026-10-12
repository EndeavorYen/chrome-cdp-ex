# Changelog fragments

Add a release note as `changelog.d/<slug>.md`. `slug` is lowercase words separated by hyphens, for example `parallel-merge.md`. Leave the `## [Unreleased]` entries that are already in `CHANGELOG.md` where they are. `npm run changelog:fold` copies fragments into that section before a tag, then deletes the fragment files.

`README.md` and `.gitkeep` stay in this directory. `.gitkeep` keeps the directory when no fragment is present.

## Format

A fragment is one or more `###` headings that already appear in `CHANGELOG.md`, in this order when they are the headings you need: `Performance`, `Features`, `Bug Fixes`. Any other `###` heading already used in `CHANGELOG.md` is also valid. Under each heading, write one or more `* ` bullets. Indent continuation lines. A blank line between bullets is optional. CRLF is accepted and stored as LF.

```markdown
### Bug Fixes

* What changed, in the same voice as `CHANGELOG.md`, with an issue link ([#123](https://github.com/EndeavorYen/chrome-cdp-ex/issues/123)).
```

Fragments that share a section are concatenated. Filenames sort by raw byte order, so the order does not depend on locale. Bullets already in `## [Unreleased]` stay ahead of fragment bullets. Section order follows the first appearance of each heading in `CHANGELOG.md`.

## Checks

`npm run check:changelog` validates every fragment. `npm run check:docs` runs that check. `npm run changelog:fold` with an empty fragment list exits 0 and leaves `CHANGELOG.md` unchanged.

Before tagging, run `npm run changelog:fold`, then move the `## [Unreleased]` notes into the new version heading. The release workflow reads that version section from `CHANGELOG.md` and does not fold fragments itself.
