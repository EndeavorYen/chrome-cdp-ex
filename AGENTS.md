# AGENTS.md - chrome-cdp-ex

## Pull Request Policy

- Open PRs against this repository's own remote main branch: `origin/main` (`EndeavorYen/chrome-cdp-ex:main`).
- Do not target an `upstream` remote for this project unless the user explicitly asks for an upstream contribution.

## Merge gate

Default local gate for ordinary and `musk/live-path` merges:

```bash
npm test
npm run lint
npm run check:docs
```

When attach, perceive, or act code changes and a supported browser exists, also run `npm run smoke:live`.

Do not treat `npm run benchmark:campaign` (10+ mixed rounds, adversarial seeds) or validation-lab phases 4–7 as merge requirements. Do not police npm registry publish as an agent process for this repository.
