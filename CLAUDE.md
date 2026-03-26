# CLAUDE.md — chrome-cdp-skill

## Problem-Solving Principles

These principles are **non-negotiable** and apply to every task in this repository.

1. **Root cause first** — When encountering an error, trace it to the root cause. Never paper over issues with workarounds. "It seems to work" ≠ "correctly fixed."
2. **Admit uncertainty** — If you don't know the root cause, say "I'm not sure" rather than inventing a plausible but unverified explanation.
3. **Challenge your own answers** — Always ask: Is this the best solution? Can it be better? Is there a fundamentally better approach?
4. **Be honest, not agreeable** — The most valuable response is the *correct* one, not the one that flatters the user. Push back when the user's direction is suboptimal.

## Project Overview

This is a **Claude Code plugin** that gives LLM agents direct access to the user's running Chrome browser via the Chrome DevTools Protocol (CDP). It connects to existing browser sessions (with login state, cookies, open tabs) — unlike Playwright which launches an isolated browser.

- **Single-file implementation**: all logic lives in `skills/chrome-cdp/scripts/cdp.mjs` (~2400 lines, zero npm dependencies)
- **Skill definition**: `skills/chrome-cdp/SKILL.md` — contains agent instructions, command reference, and workflow patterns
- **Plugin manifest**: `.claude-plugin/plugin.json`
- **Node.js 22+** required (uses built-in WebSocket)

## Architecture

```
CLI invocation
  └─► cdp.mjs main()
        ├─ list / open / stop  →  direct CDP or daemon reuse
        └─ all other commands  →  per-tab daemon (Unix socket IPC)
              ├─ persistent CDP WebSocket session
              ├─ background ring buffers (console, exceptions, navigations)
              └─ NDJSON request/response protocol
```

Key design decisions:
- **Per-tab daemon** architecture — one long-lived process per tab, auto-exits after 20min idle
- **Ring buffers** for passive observation — console (200), exceptions (50), navigations (10)
- **Realistic input simulation** — `Input.dispatchMouseEvent` with full event sequence, not `el.click()`
- **WSL2 support** — Windows-side Node.js bridges the WSL↔Windows gap

## Coding Conventions

- Pure ESM (`import`/`export`), no CommonJS
- No external dependencies — only Node.js built-ins
- Functions follow `<name>Str(cdp, sid, ...args) → string` pattern for command implementations
- New commands require registration in **5 places**: function definition, `handleCommand` switch, `NEEDS_TARGET` set, `USAGE` string, `README.md` command reference
- Shell-safe output — results are plain text strings, one per line
