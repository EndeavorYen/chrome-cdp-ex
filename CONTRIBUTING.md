# Contributing

Thanks for your interest in contributing to chrome-cdp!

## What we're looking for

- **Bug fixes** — especially edge cases in CDP interaction, browser detection, or platform-specific issues
- **New commands** — if you find yourself reaching for a CDP method that isn't wrapped yet
- **Platform support** — improvements for macOS, Linux, Windows, or WSL2
- **Documentation** — corrections, clarifications, or workflow examples

## Before you start

1. **Check existing issues** — your idea may already be discussed
2. **Open an issue first** for significant changes — let's align on the approach before you invest time

## How to contribute

1. Fork the repo and create a branch from `main`
2. Make your changes in `skills/chrome-cdp/scripts/cdp.mjs`
3. Run existing tests: `npx vitest run`
4. Test manually: `node skills/chrome-cdp/scripts/cdp.mjs list` (with Chrome debugging enabled)

## Adding a new command

New commands must be registered in **5 places**:

1. **Function definition** — implement `<name>Str(cdp, sid, ...args)` returning a string
2. **`handleCommand` switch** — add a case in the daemon's command handler
3. **`NEEDS_TARGET` set** — add the command name if it requires a tab target
4. **`USAGE` string** — add help text with description and usage
5. **`README.md`** — add to the appropriate collapsible command category

## Code style

- Pure ESM (`import`/`export`), no CommonJS
- **Zero external dependencies** — only Node.js built-ins. This is a hard rule.
- Functions return plain text strings (shell-safe output)
- Keep it simple — this is a single-file tool by design

## Testing

```bash
npx vitest run          # unit tests
npx vitest run --watch  # watch mode during development
```

Manual testing with a real Chrome instance is essential — many CDP behaviors can't be unit tested.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
