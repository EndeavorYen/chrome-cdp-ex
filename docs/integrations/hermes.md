# Hermes

## Install

```bash
node scripts/setup.mjs --for hermes
node scripts/setup.mjs --for hermes --write
```

`--for hermes` prints the resolved copy command. `--write` copies the skill into
`~/.hermes/skills/chrome-cdp-ex`, or `$HERMES_HOME/skills/chrome-cdp-ex` when
`HERMES_HOME` is set.

```bash
node ~/.hermes/skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node ~/.hermes/skills/chrome-cdp-ex/scripts/cdp.mjs list
```

## Route

Prefer **CLI / shell** calls to `scripts/cdp.mjs` (lower token cost in matched campaigns). Use MCP only if the Hermes session is MCP-native.

```bash
node /absolute/path/to/chrome-cdp-ex/scripts/cdp.mjs doctor
node /absolute/path/to/chrome-cdp-ex/scripts/cdp.mjs list
./bin/chrome-cdp perceive <target> -C -d 8
```

See also: `skills/chrome-cdp-ex/hosts/hermes.md`.
