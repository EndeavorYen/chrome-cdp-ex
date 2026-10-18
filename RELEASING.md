# Releasing

## Cadence

Cut a release every second Monday counting from 2026-11-02 (the first scheduled release after v2.22.0), when `main` has unreleased changelog entries. Do not publish an empty release.

## Early release

An early release is allowed for a security fix, a regression in the last release, or a bug fix that blocks normal use. Bump the patch version.

## Do not release when

- CI on `main` is not green, or the Chrome stable smoke run is not green.
- Any open issue or pull request carries the `release-blocker` label.
- Unfolded changelog fragments fail `node scripts/changelog-fragments.mjs --release`.

## Versioning

Versions follow semantic versioning.

- A patch release is bug fixes only.
- A minor release is new features or behaviour changes that keep existing commands working.
- A major release removes or renames a command or flag, or changes a documented output field or JSON schema in a way that breaks callers.

The 2.x history sometimes shipped Breaking Changes as a minor. From this policy on, breaking output changes take a major.

## Who releases

The maintainer reviews and merges a release-prep pull request. The steps for that pull request are in the Release section of [AGENTS.md](AGENTS.md). `.github/workflows/release.yml` publishes only when `CHANGELOG.md` has a `## [<version>]` heading matching `package.json` and the tag does not exist yet; any other push to `main` is a no-op. Merging that pull request creates the tag, the GitHub Release, and the npm publish. The first npm publish is manual, once. If the workflow fails before the tag exists, fix the problem and merge again. If only the npm step fails, re-run the workflow manually with the existing tag (`workflow_dispatch` input `version`); merging again does nothing because the tag exists.
