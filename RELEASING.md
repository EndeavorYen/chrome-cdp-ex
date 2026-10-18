# Releasing

## Cadence

Cut a release every two weeks, on alternate Mondays, when `main` has unreleased changelog entries. Do not publish an empty release.

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

The maintainer reviews and merges a release-prep pull request. The steps for that pull request are in the Release section of [AGENTS.md](AGENTS.md). After the merge, `.github/workflows/release.yml` tags the version and publishes the GitHub Release. Nobody tags or publishes by hand. If that workflow fails, fix the problem and merge again.
