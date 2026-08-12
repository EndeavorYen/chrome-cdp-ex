# Codex

## Install

```bash
mkdir -p ~/.codex/skills
cp -R skills/chrome-cdp-ex ~/.codex/skills/
node scripts/setup.mjs --for codex
```

The slim `SKILL.md` loads first; deep command docs live in `references/commands.md`.

## Route

Prefer **CLI** (`node .../scripts/cdp.mjs ...`). Use MCP only when the Codex session is MCP-first.

## Verify

```bash
node ~/.codex/skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node scripts/setup.mjs --verify
```

## Validation route and evidence

The [Codex Killer Path](../examples/codex-killer-path.md) separates the host route from the runtime benchmark and uses a disposable local fixture. The [host-validation manifest](../benchmarks/host-validation.v1.json) is the source of truth for the current evidence status; installation support alone is not labeled live validation.

Phase 1 candidate v2.15.0 evidence status: **live-validated** on 2026-08-12
through the CLI-skill route, using that exact packed candidate copied into a
disposable Codex skill directory and an isolated local debug-browser fixture.
Its identity digest begins `sha256:802f7add`. Phase 2 initially changed only
package/contract metadata, but later Runtime v3 phases changed runtime and
candidate inputs substantially. The Phase 1 result is historical for that
earlier tree and must not be presented as current-tree or release proof. The
newer Runtime v3 live scenarios validate disposable CLI/MCP/runtime behavior,
not the full Codex installation campaign. See the Killer Path for the observed
schemas and claim boundary.

See also: `skills/chrome-cdp-ex/hosts/codex.md`.
