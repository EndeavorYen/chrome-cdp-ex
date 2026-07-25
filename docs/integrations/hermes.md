# Hermes

## Install

```bash
cp -R skills/chrome-cdp-ex <hermes-skills-dir>/chrome-cdp-ex
node scripts/setup.mjs --for hermes
```

## Route

Prefer **CLI / shell** calls to `scripts/cdp.mjs` (lower token cost in matched campaigns). Use MCP only if the Hermes session is MCP-native.

```bash
node /absolute/path/to/chrome-cdp-ex/scripts/cdp.mjs doctor
node /absolute/path/to/chrome-cdp-ex/scripts/cdp.mjs list
./bin/chrome-cdp perceive <target> -C -d 8
```

See also: `skills/chrome-cdp-ex/hosts/hermes.md`.
