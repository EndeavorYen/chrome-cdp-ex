# AGENTS.md - chrome-cdp-ex

@/Users/simon/.codex/RTK.md
@/Users/simon/.codex/CLAUDE_CODE_BOOST.md

## Pull Request Policy

- Open PRs against this repository's own remote main branch: `origin/main` (`EndeavorYen/chrome-cdp-ex:main`).
- Do not target an `upstream` remote for this project unless the user explicitly asks for an upstream contribution.

## Release Policy

- Do not publish this repository to the npm registry.
- Treat GitHub Releases, release tags, GitHub Pages, and attached release assets as the official publish surface.
- `npm pack`, `npm pack --dry-run`, and `npm publish --dry-run` are allowed for package validation only.
- Do not treat npm registry ownership, npm login state, or npm `latest` drift as blockers for this project.
- When releasing, verify tests/docs/lint/package contents, create the GitHub release, attach the package tarball if useful, and leave local/remote branches clean.
