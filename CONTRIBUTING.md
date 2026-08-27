# Contributing

> **TL;DR** — Start from `main`, write a failing test, update the current `skills/chrome-cdp-ex` runtime and docs, then run the default local gates. When attach, perceive, or act code changes and a browser exists, also run focused live smoke.

Thanks for contributing to `chrome-cdp-ex`.

## What we're looking for

- **Bug fixes** — especially edge cases in CDP interaction, browser detection, or platform-specific issues
- **New commands** — if you find yourself reaching for a CDP method that isn't wrapped yet
- **Platform support** — improvements for macOS, Linux, Windows, or WSL2
- **Documentation** — corrections, clarifications, or workflow examples

## Before you start

1. Check existing issues and pull requests.
2. Open an issue first for significant behavior, command, or contract changes.

## How to contribute

1. Fork the repository and create a branch from `main`.
2. Add a failing Vitest regression for the behavior you are changing.
3. Make the smallest complete change in `skills/chrome-cdp-ex/scripts/cdp.mjs` or its focused helpers under `scripts/lib/`.
4. Update help, skill, reference, MCP, and release-facing docs when their contracts change.
5. Run the default local gates below. When attach, perceive, or act code changed and a browser exists, also run focused live smoke.

## Adding a new command

New commands normally touch these surfaces:

1. Implement a command helper, usually `<name>Str(cdp, sid, ...args)`.
2. Add the daemon `handleCommand` case or targetless CLI route.
3. Add metadata to `COMMANDS`; `NEEDS_TARGET` is generated from this registry.
4. Add concise `USAGE`, `SKILL.md`, and `docs/reference.md` guidance.
5. Add unit tests, docs-contract coverage, and an MCP definition/mapping when agents need the command through stdio MCP.

## Code style

- Pure ESM (`import`/`export`), no CommonJS
- Shipped runtime code uses Node.js built-ins only; development tooling may use npm packages.
- Prefer pure helpers in `scripts/lib/` when they reduce complexity across command surfaces.
- Keep human text shell-friendly and JSON handoffs versioned, bounded, and parseable.
- Redact secrets by default. Full state or large payloads require an explicit unsafe/verbose flag.
- Mutating commands must expose action evidence, settlement semantics, and recovery guidance.

## Testing

Default local gate for ordinary and `musk/live-path` merges:

```bash
npm test              # unit tests
npm run lint          # ESLint (warnings allowed, errors fail)
npm run check:docs    # command, release, and contributor documentation contracts
```

When attach, perceive, or act code changes and a supported browser is installed, also run `npm run smoke:live`. It skips if no supported browser is available. Manual testing with a real Chrome/Edge instance still helps because many CDP behaviors cannot be unit tested; the live smoke starts an isolated profile, exercises long-session workflows, and cleans up its temporary state.

Do not treat `npm run benchmark:campaign` (10+ mixed rounds, adversarial seeds) or validation-lab phases 4–7 as merge requirements. Those scripts may remain in `scripts/` and `validation/` as optional historical harnesses; they are not contributor merge instructions.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
