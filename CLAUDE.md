# CLAUDE.md — chrome-cdp-ex

> **TL;DR** — The product runtime is `skills/chrome-cdp-ex/scripts/cdp.mjs`, supported by focused helpers in `scripts/lib/`, a stdio MCP adapter, and release-quality live benchmarks. Preserve the zero-runtime-dependency design, structured handoff contracts, privacy defaults, and evidence-first workflow.

## Problem-Solving Principles

These principles are **non-negotiable** and apply to every task in this repository.

1. **Root cause first** — When encountering an error, trace it to the root cause. Never paper over issues with workarounds. "It seems to work" ≠ "correctly fixed."
2. **Admit uncertainty** — If you don't know the root cause, say "I'm not sure" rather than inventing a plausible but unverified explanation.
3. **Challenge your own answers** — Always ask: Is this the best solution? Can it be better? Is there a fundamentally better approach?
4. **Be honest, not agreeable** — The most valuable response is the *correct* one, not the one that flatters the user. Push back when the user's direction is suboptimal.

## Project Overview

This is a **Claude Code plugin and portable agent skill** that gives LLM agents direct access to the user's running Chrome browser via the Chrome DevTools Protocol (CDP). It connects to existing browser sessions with login state, cookies, and open tabs; Playwright remains the better choice for clean deterministic test browsers.

- **Command runtime**: `skills/chrome-cdp-ex/scripts/cdp.mjs`.
- **Focused helpers**: `skills/chrome-cdp-ex/scripts/lib/` owns action recovery, receipt surfaces, perception models, reports, page/screenshot/responsive health, target binding, and MCP mapping.
- **MCP server**: `skills/chrome-cdp-ex/scripts/mcp-server.mjs` maps stdio MCP calls to the same CLI runtime.
- **Skill definition**: `skills/chrome-cdp-ex/SKILL.md` is the always-loaded golden path; exhaustive command docs live in `skills/chrome-cdp-ex/references/`.
- **Plugin manifest**: `.claude-plugin/plugin.json` must match `package.json` version metadata.
- **Runtime dependencies**: Node.js 22+ and built-ins only; npm packages are development/test tooling.

## Architecture

```
CLI invocation
  └─► cdp.mjs main()
        ├─ list / open / stop  →  direct CDP or daemon reuse
        └─ all other commands  →  per-tab daemon (Unix socket IPC)
              ├─ persistent CDP WebSocket session
              ├─ background ring buffers (console, exceptions, navigations)
              ├─ structured action receipts and session reports
              └─ NDJSON request/response protocol

stdio MCP client
  └─► mcp-server.mjs → mcp-adapter.mjs → cdp.mjs command
```

Key design decisions:
- **Per-tab daemon** architecture — one long-lived process per tab, auto-exits after 20min idle
- **Ring buffers** for passive observation — console (200), exceptions (50), navigations (10)
- **Realistic input simulation** — `Input.dispatchMouseEvent` with full event sequence, not `el.click()`
- **WSL2 support** — Windows-side Node.js bridges the WSL↔Windows gap

## Coding Conventions

- Pure ESM (`import`/`export`), no CommonJS
- No runtime dependencies — only Node.js built-ins in shipped code
- Functions follow `<name>Str(cdp, sid, ...args) → string` pattern for command implementations
- Register commands in `COMMANDS`; `NEEDS_TARGET` is derived from that registry
- Keep JSON outputs versioned, bounded, redacted by default, and paired with executable recovery or next steps
- Add explicit `--unsafe-full` / verbose opt-ins only when full sensitive or large output is genuinely useful
- Update `USAGE`, `SKILL.md`, `docs/reference.md`, tests, and MCP definitions when the public surface changes

## Verification

```bash
npm test
npm run lint
npm run check:docs
npm audit --audit-level=high
npm run smoke:live
```

Changes to browser orchestration, benchmarks, MCP routing, token budgets, or release claims also require a focused live campaign. Release-facing work requires a passing 10+ round mixed campaign, package inspection, PR review, green CI, and a GitHub Release asset; this repository does not publish to npm.
