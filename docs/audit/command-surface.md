# Command surface audit (Phase A: inventory)

> **TL;DR** — The catalog has 82 commands. The survivor card teaches 20, and MCP serves 14 tools. Runtime output names 35 non-survivor commands as `cdp <name>`, and 14 of those are reachable from the output of card commands. So the 20-command card is not a closed surface, and MCP agents cannot run most of those `Next:` commands. The highest-risk breaks are:
> - `press Enter` can click a link instead of pressing Enter, and it still reports "Pressed Enter" (A-01).
> - `select` rejects the `@ref` that SKILL and its own recovery hint tell agents to use (A-02).
> - `cookies`, `console`, `status`, `list` and `perceive` print values that action receipts redact (A-04).
>
> Each finding is a candidate for Phase B. A finding marked **[repro B]** still needs a live reproduction before it can be classified.

Phase A of the 2026-10 audit. This phase only reads and measures: no runtime code changed. Line numbers refer to commit `21e96b5` (v2.21.0). Path prefixes in tables:

- `cs:` is `skills/chrome-cdp-ex/scripts/lib/command-surface.mjs`.
- `cdp:` is `skills/chrome-cdp-ex/scripts/cdp.mjs`.
- `ar:` is `skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs`.
- `mcp:` is `skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs`.

## 0. Method

| Evidence | How it was produced | Result |
|---|---|---|
| Baseline tests | `npm test` (Windows 11, Node 24.21, `npm ci` in a worktree) | exit 1: 2 failed / 3928 passed / 86 skipped in 102 s. Both failures are in `tests/issue-358-first-step.test.mjs`. The file passes alone (5/5), and the full suite passes with `--maxWorkers=2` (A-24). |
| Coverage | `node scripts/run-vitest.mjs --coverage --coverage.reporter=json --maxWorkers=2` | exit 0, 185/185 files. `cdp.mjs` in-process: 1598/1728 functions, 22832/27373 statements. |
| Command census | `node docs/audit/command-census.mjs` (TSV) or `--json` | §4 table. |
| Flag census | Every `--flag` in SKILL.md, references/*.md, docs/reference.md and killer-path.md, searched for in the shipped runtime source | §5.5 |
| Hint census | Every `cdp <command>` string literal in shipped runtime code (also printed by the census as `hintSites`) | §3.6 |
| Error-kind probes | `__test__.buildCliErrorRecovery(message, { cmd })` with representative messages | A-07 (§5.2) |
| CLI output size | `bin/chrome-cdp help`, `help <cmd>`, and argument errors with no browser (`CDP_PORT=9555`) | `help`: 1,911 chars, 38 lines. Typo error: 227 chars, 8 lines. Missing-target error: 377 chars, 8 lines. |

Not done in Phase A: live browser runs, receipt byte measurement, or the Haiku probe.

## 1. Surface inventory

| Surface | Count | Owner |
|---|---|---|
| Catalog commands / aliases | 82 / 23 | `cs:815-898` |
| Target / targetless | 69 / 13 | `needsTarget` in each record; target commands route through `cdp:27665-27738`, targetless through `main()` `cdp:32743-33247` |
| Survivor card | 20 | `cs:903-924`, `SKILL.md:63`, card text `cdp:30685-30715` |
| MCP tools served | 14 (13 + `run_command`) | definitions `cs:388-813`, survivor filter `cs:968-972` |
| MCP tools defined but not in `tools/list` (still callable by name, A-06) | 13 (`select_target`, `controls`, `overlay`, `verify_click`, `drag`, `viewport`, `qa_page`, `responsive_audit`, `report`, `components`, `record_snapshot`, `session_checkpoint`, `table`) | `cs:388-813`, mapper table `cs:1027-1032` |
| MCP `run_command` allowlist | 72 spellings declared, 27 served | `cs:342-355`, filter `cs:940-942` |
| Reach of the 82 commands (§4) | card 21 (20 survivors + `help`), SKILL-aside 6, hint 11, hint² 3, none 41 | §4 |
| Output formats | 56 accept `--format json`; 26 are text only, 5 of them survivors (`eval`, `shot`, `elshot`, `waitfor`, `text`) | each record's `outputFormats` |
| Versioned JSON schema ids emitted | 76 distinct `chrome-cdp-ex.*.vN` | runtime string literals |
| Published schema files | 5 (`docs/schemas/`) | none is validated by a test (A-18) |
| Agent-facing text sizes (Unicode code points) | SKILL.md 7,401 (frontmatter 1,410); references/commands.md 165,619; recipes 10,008; troubleshooting 17,298; docs/reference.md 86,631; `cdp help` 1,911; MCP `tools/list` 10,965 | measured |
| Tests | 185 files (83 named `issue-*`, 10 `runtime-v3-*`), 4,016 tests | `tests/` |

## 2. Registration points: what changing one command touches

Every change below is checked by its own validator, which fails on drift. The checks are useful; the hand-maintained copies are the cost.

1. The catalog record: `cs:815-898`.
2. The catalog digest: `COMMAND_SURFACE_IDENTITY` `cs:1044`, checked at `cs:1046-1048`. Changing the MCP surface also changes `MCP_SURFACE_IDENTITY` `cs:1045`.
3. A survivor also needs `SURVIVOR_COMMANDS` `cs:903-924` and `MCP_RUN_COMMAND_ALLOWLIST_INPUT` `cs:342-355`.
4. A first-class MCP tool needs its definition (`cs:388-813`), the mapper set `MCP_TOOL_MAPPERS` `cs:16-21`, a mapper branch in `buildMcpToolCommand` `mcp:269-521`, and possibly a confirm rule in `argsRequireConfirm` `mcp:202-230` and image handling in `MCP_IMAGE_COMMANDS` `mcp:526`.
5. The full-catalog help layout `CLI_HELP_LAYOUT` `cdp:29862-30355` and a `{{command:…}}` marker in `CLI_HELP_TEMPLATE` `cdp:30357-30643`. `renderCliHelp` throws at module load on any drift (`cdp:30650-30664`), but that help is never printed (A-15).
6. A target command needs its handler builder in `DAEMON_HANDLER_BUILDERS` `cdp:27665-27738`, whose exact coverage is checked at startup (`cdp:27754-27760`).
7. The daemon capability: `readCapabilities` `cdp:28334`, `scriptCapabilities` `cdp:28480`, `actionCapabilities` `cdp:28498` or `workflowCapabilities` `cdp:28852`.
8. The matching exact-cover list: `COMMANDS` in `lib/daemon-read-handlers.mjs:4-8` or `lib/daemon-action-handlers.mjs:1-6`.
9. The authorization allowlist: per-command name lists in `authorizeDaemonApplicationCommand` `cdp:31106-31134`.
10. CLI argument normalization in `main()`: `cdp:33408-33493`, `normalizeTargetCommandArgs` `cdp:31254`, and `absolutizeCallerFileArgs` `cdp:16467-16478` for path arguments.
11. Error recovery templates: `commandUsageTemplate` `cdp:31357-31430` and per-command branches in `buildCliErrorRecovery` `cdp:31447-32075`.
12. Record/replay/export mapping: `inferRecordActionCommand` `cdp:11873` and `playwrightStepFromCommand` `cdp:12187`.
13. Hard-coded catalog size `82`: `scripts/generate-command-surfaces.mjs:35` and `tests/generated-command-surfaces.test.mjs:24-25`.
14. Contract fixtures in `docs/contracts/v2.21.0/` (`public-contracts.v1.json` holds command, alias and MCP metadata; `runtime-dispatch.v1.json` holds route digests), plus SKILL.md, references/commands.md, and the generated region in docs/reference.md.

Cost of a new leftover target command: 10 code edits (items 1, 2, 5 ×2, 6, 7, 8, 9, 13 ×2), 2 fixtures, and 1 reference doc. The docs contract requires the reference doc for leftover commands. A new survivor that is also an MCP tool adds items 3 and 4 (up to 7 more edits) and SKILL.md. Items 5, 8, 9 and 12 restate the catalog by hand.

## 3. Call graph

### 3.1 CLI process path

```
bin/chrome-cdp ──spawn──► node cdp.mjs   (second Node process; #600 measures ~33 ms)
  main() cdp:32743
   ├─ preflightDaemonApplication() cdp:32748   (builds the 82-command registry on every call)
   ├─ session policy  cdp:32761-32778
   ├─ help / list / tab-group / broadcast / target / open / stop / doctor / spawn /
   │  attach|use / forget / current / targetless wait     cdp:32780-33246  (in-process adapters)
   └─ target command:
        resolvePageCommandTarget cdp:3457 → BrowserSupervisor (lib/browser-supervisor.mjs)
        → getOrStartTabDaemon cdp:29266 (spawns `cdp.mjs _daemon <id>` detached)
        → assertFreshDaemonForCommand cdp:29360 → sendCommand cdp:29309 (NDJSON over socket)
        → emitTargetCommandResponse cdp:32670 → stdout/stderr + exit code
```

### 3.2 Daemon dispatch

```
runDaemon cdp:27904 → handleCommand cdp:29016
  → executeDaemonApplicationRoute cdp:31136 → createCommandDispatcher (lib/command-dispatch.mjs:69)
  → executeCommand (lib/command-application.mjs) → authorizeDaemonApplicationCommand cdp:31106
  → DAEMON_HANDLER_BUILDERS[cmd] cdp:27665 → capability cdp:28334-28891 → *Str implementation
  → cdpDomains(...) (lib/cdp-domains.mjs) → WebSocket (lib/ws-transport.mjs)
```

### 3.3 Action pipeline (every `kind: mutation` command with a feedback policy)

```
capability → actionFeedback / runActionWithFeedback cdp:10399
  baseline perceive + console/network snapshot → dispatch (*Str) → settle
  → perceive diff (feedbackPolicy: settle-diff | state-change | full-perceive | report-only)
  → classifyActionFailure ar:462 on error → formatActionText cdp:9109 / JSON envelope
  → formatActionResultOutput cdp:9415 (redaction + secret scrub) → receipt
```

### 3.4 Composite and recursive commands

| Caller | Calls | Guard |
|---|---|---|
| `batch` `cdp:28853-28872` | any command through `handleCommand` | `BATCH_BLOCKED` `cdp:24516`; `--parallel` read-only check `cdp:24320` |
| `flow` `cdp:28873-28883` | any command, plus the `wait dom stable` / `wait network idle` and `assert …` keywords | parser `cdp:24641-24665` (A-21) |
| `repeat` `cdp:28884-28887` | one command N times | `REPEAT_BLOCKED` `cdp:24515` |
| `replay` `cdp:28888-28890` | recorded steps | `REPLAY_BLOCKED` `cdp:24855` |
| `broadcast` `cdp:32881-32956` | one command per tab-group member, through each member's daemon | policy preflight `cdp:32887-32890` |
| `open --perceive` `cdp:33099-33112`, `nav --perceive` `cdp:28644`, `back`/`forward` `cdp:28501`, `cdp:28624` | full `perceive` | — |
| `qa`, `responsive-audit`, `verify-click` | perceive + shot + viewport (+ click) | — |
| MCP resources `mcp:251-253` | `doctor`, `report`, `shot` | — |

### 3.5 MCP path

```
mcp-server.mjs tools/call → buildMcpToolCommand mcp:269 (tool args → CLI argv; forces --format json on
  perceive/click/fill/press/navigate/dismiss_modal/…) → mcpPolicyDenial mcp:715
  → runtime-client.mjs → executeCdpCli cdp:32625 (in-process main(), no child spawn)
  → createMcpToolResult mcp:671 (text = stdout or stderr+stdout; image block for shot/elshot/fullshot;
    structuredContent = the same JSON when stdout is a versioned JSON object)
```

### 3.6 Runtime hint edges: what receipts and errors tell agents to run next

String-literal `cdp <command>` sites in shipped runtime code (from `hintSites` in the census). Survivor targets: `perceive` 60, `list` 24, `click` 14, `doctor` 9, `eval` 8, `text` 7, `open` 7, `dismiss-modal` 7, `stop` 6, `spawn-debug-browser` 5, `nav` 4, `shot`/`fill`/`elshot`/`inject`/`waitfor` 1. Non-survivor targets, with example sites:

| Non-survivor | Sites | Examples |
|---|---|---|
| `help` | 70 | `cdp help <cmd>` usage recoveries, e.g. `cdp:31530`, `ar:847` |
| `report` | 20 | `cdp:4150`, `cdp:8671`, `cdp:9973`, `cdp:10116`, perceive `--qa` `cdp:30930` |
| `netlog` | 14 | action network failure `cdp:8523`, `cdp:31796-31808` |
| `status` | 12 | unclassified CLI error `cdp:32063-32068`, CDP timeout `cdp:32050-32054`, action failure default `ar:475`, `ar:643`, `ar:746` |
| `overlay` | 6 | covered click `ar:207`, `ar:284` |
| `record-actions` / `export-playwright` | 5 / 2 | session report `cdp:11658-11659`, `cdp:14881` |
| `jsclick` | 5 | `cdp:32021`, `cdp:32032`, `ar:560`, `ar:718`, `ar:759` |
| `back`, `dialog`, `reload` | 4, 1, 1 | policy-navigated `ar:505`, navigation cancelled `ar:312-313` |
| `console`, `frame` | 3, 2 | `cdp:8511`, `ar:1612`, frame check `ar:1321` |
| `clickxy` | 1 literal, plus every perceive header | `Coords: … (use clickxy with these values …)` `cdp:15934` |

## 4. Command map

The census gives every column except **Reach** and **Impl**. Reach is the shortest path by which an agent that has only SKILL.md, `cdp help` and command output learns the command name:

- **card**: on the survivor card (`SKILL.md:63`, `cdp help`).
- **SKILL-aside**: named in SKILL.md outside the card: `viewport`/`responsive-audit` (`SKILL.md:17`), `html`/`status` (`SKILL.md:44`), `flow`/`batch` (`SKILL.md:36`).
- **hint**: printed as a next step by a card command (§3.6).
- **hint²**: printed only by a hint-reachable command (`report` → `record-actions`, `export-playwright`; `target` → `use`).
- **none**: no path except reading the 165,619-char references/commands.md or guessing.

The Impl column gives v8 in-process hits of the implementation function in the coverage run. Every daemon capability line (`cdp:28334-28891`) and `runDaemon` itself (`cdp:27904`) has **0** in-process hits (A-13).

| Command (aliases) | Tgt | Kind | Formats | Catalog | Handler | Reach | MCP | Hint sites | refs.md lines | Impl (v8 hits) |
|---|---|---|---|---|---|---|---|---|---|---|
| `help` | – | read | text | cs:816 | cdp:32783 | card | `run_command` | 70 | 8 | — |
| `list` (tabs, ls) | – | read | text+json | cs:817 | cdp:32794 | card | tool `list_tabs` | 24 | 18 | — |
| `target` | – | read | text+json | cs:818 | cdp:32959 | hint | — (hidden `select_target`) | 1 | 7 | — |
| `tab-group` (tabgroup) | – | conditional-mutation | text+json | cs:819 | cdp:32817 | none | — | 3 | 2 | — |
| `broadcast` | – | mutation | text+json | cs:820 | cdp:32881 | none | — | 0 | 7 | — |
| `open` | – | mutation | text+json | cs:821 | cdp:32981 | card | tool `open_or_attach` | 7 | 21 | — |
| `doctor` (ready) | – | read | text+json | cs:822 | cdp:33142 | card | tool `doctor` | 9 | 9 | `runDoctorChecks` 16 |
| `spawn-debug-browser` (spawn) | – | mutation | text+json | cs:823 | cdp:33154 | card | tool `spawn_debug_browser` | 5 | 10 | `spawnDebugBrowserStr` 45 |
| `attach` | – | protected-mutation | text+json | cs:824 | cdp:33172 | none | — | 0 | 5 | — |
| `use` | – | protected-mutation | text+json | cs:825 | cdp:33172 | hint² | — | 4 | 6 | — |
| `forget` | – | protected-mutation | text+json | cs:826 | cdp:33212 | none | — | 0 | 3 | — |
| `current` | – | read | text+json | cs:827 | cdp:33230 | none | — | 1 | 3 | — |
| `stop` | – | mutation | text+json | cs:828 | cdp:33123 | card | `run_command` | 6 | 8 | `stopDaemons` 34 |
| `perceive` | T | read | text+json | cs:829 | cdp:27666 | card | tool `perceive` | 60 | 97 | `perceiveStr` 182 |
| `snap` (snapshot) | T | read | text | cs:830 | cdp:27676 | none | — | 0 | 12 | `snapshotStr` 5 |
| `controls` | T | read | text+json | cs:831 | cdp:27677 | none | — (hidden `controls`) | 0 | 5 | `controlsStr` 3 |
| `eval` | T | script | text | cs:832 | cdp:27714 | card | — | 8 | 28 | `evalStr` 1462 |
| `eval64` | T | script | text | cs:833 | cdp:27715 | none | — | 1 | 7 | — |
| `call` | T | script | text | cs:834 | cdp:27716 | none | — | 1 | 5 | `callStr` 2 |
| `wait` | T | read | text | cs:835 | cdp:27684 | none | — | 1 | 8 | `waitStr` 1 |
| `keepalive` | T | protected-mutation | text | cs:836 | cdp:27712 | none | — | 0 | 4 | `extendKeepalive` 2 |
| `shot` (screenshot) | T | conditional-mutation | text | cs:837 | cdp:27729 | card | tool `screenshot` | 1 | 24 | `shotStr` 21 |
| `diff-shot` (diffshot) | T | conditional-mutation | text+json | cs:838 | cdp:27730 | none | — | 1 | 7 | `diffShotStr` 1 |
| `html` | T | read | text | cs:839 | cdp:27670 | SKILL-aside | — | 0 | 7 | `htmlStr` 7 |
| `nav` (navigate) | T | mutation | text+json | cs:840 | cdp:27702 | card | tool `navigate` | 4 | 35 | `navStr` 21 |
| `net` (network) | T | read | text | cs:841 | cdp:27673 | none | — | 0 | 2 | `netStr` 1 |
| `mock` (network-mock) | T | mutation | text+json | cs:842 | cdp:27705 | none | — | 2 | 10 | `mockStr` 12 |
| `clock` (time-travel) | T | mutation | text+json | cs:843 | cdp:27704 | none | — | 3 | 11 | `clockStr` 5 |
| `throttle` (network-throttle) | T | mutation | text+json | cs:844 | cdp:27706 | none | — | 3 | 14 | `throttleStr` 10 |
| `status` | T | read | text+json | cs:845 | cdp:27674 | SKILL-aside | — | 12 | 13 | `statusStr` 16 |
| `console` | T | conditional-mutation | text+json | cs:846 | cdp:27717 | hint | — | 3 | 9 | `consoleStr` 12 |
| `summary` | T | read | text+json | cs:847 | cdp:27675 | none | — | 0 | 6 | `summaryStr` 3 |
| `frame` (frames) | T | read | text+json | cs:848 | cdp:27678 | hint | — | 2 | 4 | `framesStr` 1 |
| `overlay` (overlays) | T | read | text+json | cs:849 | cdp:27679 | hint | — (hidden `overlay`) | 6 | 6 | `overlayStr` 14 |
| `report` | T | evidence | text+json | cs:850 | cdp:27668 | hint | — (hidden `report`) | 20 | 21 | `formatSessionReport` 43 |
| `checkpoint` | T | sensitive-read | text+json | cs:851 | cdp:27687 | none | — (hidden `session_checkpoint`) | 0 | 4 | `checkpointStr` 1 |
| `restore` | T | mutation | text+json | cs:852 | cdp:27727 | none | — | 0 | 6 | `restoreCheckpointStr` 8 |
| `record-actions` (recordactions) | T | read | text+json | cs:853 | cdp:27682 | hint² | — | 5 | 8 | `formatRecordActions` 40 |
| `export-playwright` (export-pw) | T | read | text+json | cs:854 | cdp:27683 | hint² | — | 2 | 6 | `formatExportPlaywright` 14 |
| `replay` | T | mutation | text+json | cs:855 | cdp:27722 | none | — | 0 | 11 | `replayActionsStr` 12 |
| `elshot` | T | conditional-mutation | text | cs:856 | cdp:27731 | card | `run_command` | 1 | 20 | `elshotStr` 7 |
| `qa` (qa-page) | T | mutation | text+json | cs:857 | cdp:27734 | none | — (hidden `qa_page`) | 0 | 10 | `qaPageStr` 3 |
| `responsive-audit` (visual-check) | T | mutation | text+json | cs:858 | cdp:27735 | SKILL-aside | — (hidden `responsive_audit`) | 0 | 9 | `responsiveAuditStr` 9 |
| `verify-click` (verifyclick) | T | mutation | text+json | cs:859 | cdp:27699 | none | — (hidden `verify_click`) | 0 | 7 | `clickStr` 71 |
| `click` | T | mutation | text+json | cs:860 | cdp:27667 | card | tool `click` | 14 | 48 | `clickStr` 71 |
| `jsclick` | T | mutation | text+json | cs:861 | cdp:27697 | hint | — | 5 | 15 | `jsClickStr` 44 |
| `clickxy` | T | mutation | text+json | cs:862 | cdp:27694 | hint | — | 1 | 7 | `clickXyStr` 1 |
| `type` | T | mutation | text+json | cs:863 | cdp:27698 | none | — | 1 | 6 | `typeStr` 0 |
| `press` (key) | T | mutation | text+json | cs:864 | cdp:27691 | card | tool `press` | 0 | 14 | `pressStr` 25 |
| `scroll` | T | mutation | text+json | cs:865 | cdp:27692 | card | `run_command` | 0 | 9 | `scrollStr` 60 |
| `hover` | T | protected-mutation | text | cs:866 | cdp:27690 | none | — | 0 | 3 | `hoverStr` 11 |
| `drag` | T | mutation | text+json | cs:867 | cdp:27696 | none | — (hidden `drag`) | 2 | 7 | `dragStr` 21 |
| `waitfor` | T | read | text | cs:868 | cdp:27685 | card | tool `wait_for` | 1 | 19 | `waitForStr` 24 |
| `loadall` | T | protected-mutation | text | cs:869 | cdp:27737 | none | — | 0 | 5 | `loadAllStr` 4 |
| `fill` | T | mutation | text+json | cs:870 | cdp:27689 | card | tool `fill` | 1 | 41 | `fillStr` 104 |
| `select` | T | mutation | text+json | cs:871 | cdp:27693 | card | `run_command` | 0 | 9 | `selectStr` 9 |
| `fullshot` | T | conditional-mutation | text | cs:872 | cdp:27732 | none | — | 0 | 7 | `fullshotStr` 5 |
| `scanshot` | T | read | text | cs:873 | cdp:27733 | none | — | 0 | 7 | `scanshotStr` 3 |
| `styles` | T | read | text | cs:874 | cdp:27680 | none | — | 0 | 8 | `stylesStr` 5 |
| `components` | T | sensitive-read | text+json | cs:875 | cdp:27681 | none | — (hidden `components`) | 0 | 4 | `componentsStr` 3 |
| `cookies` | T | sensitive-read | text | cs:876 | cdp:27688 | none | — | 2 | 4 | `cookiesStr` 0 |
| `cookieset` | T | mutation | text | cs:877 | cdp:27710 | none | — | 1 | 5 | `cookieSetStr` 0 |
| `cookiedel` | T | mutation | text | cs:878 | cdp:27709 | none | — | 1 | 3 | `cookieDelStr` 5 |
| `evalraw` | T | raw-cdp | text | cs:879 | cdp:27669 | none | — | 1 | 4 | — |
| `batch` | T | composite | text+json | cs:880 | cdp:27719 | SKILL-aside | — | 0 | 24 | `runBatchCommands` 3 |
| `dialog` | T | protected-mutation | text | cs:881 | cdp:27711 | hint | — | 1 | 11 | `setDialogMode` 5 |
| `viewport` (resize) | T | mutation | text+json | cs:882 | cdp:27708 | SKILL-aside | — (hidden `viewport`) | 1 | 9 | `viewportStr` 13 |
| `emulate` | T | mutation | text+json | cs:883 | cdp:27707 | none | — | 0 | 3 | `emulateStr` 15 |
| `upload` | T | mutation | text+json | cs:884 | cdp:27728 | none | — | 1 | 11 | `uploadStr` 6 |
| `text` | T | read | text | cs:885 | cdp:27671 | card | `run_command` | 7 | 36 | `textStr` 9 |
| `table` | T | conditional-mutation | text+json | cs:886 | cdp:27672 | none | — (hidden `table`) | 1 | 15 | `tableObservationStr` 35 |
| `back` | T | mutation | text+json | cs:887 | cdp:27700 | hint | — | 4 | 7 | `historyNavStr` 0 |
| `forward` | T | mutation | text+json | cs:888 | cdp:27701 | none | — | 0 | 6 | `historyNavStr` 0 |
| `reload` | T | mutation | text+json | cs:889 | cdp:27703 | hint | — | 1 | 11 | `reloadStr` 17 |
| `closetab` | T | mutation | text | cs:890 | cdp:27736 | none | — | 0 | 7 | `closetabStr` 8 |
| `netlog` | T | conditional-mutation | text+json | cs:891 | cdp:27713 | hint | — | 14 | 19 | `netlogStr` 26 |
| `inject` | T | mutation | text+json | cs:892 | cdp:27726 | card | `run_command` | 1 | 12 | `injectStr` 14 |
| `cascade` | T | read | text+json | cs:893 | cdp:27686 | card | tool `cascade` | 0 | 13 | `cascadeStr` 33 |
| `record` | T | conditional-mutation | text | cs:894 | cdp:27718 | none | — (hidden `record_snapshot`) | 0 | 34 | `recordStr` 8 |
| `flow` | T | composite | text+json | cs:895 | cdp:27720 | SKILL-aside | — | 1 | 19 | `flowStr` 171 |
| `repeat` | T | composite | text | cs:896 | cdp:27721 | none | — | 0 | 23 | `repeatStr` 16 |
| `dismiss-modal` (dismissmodal) | T | mutation | text+json | cs:897 | cdp:27695 | card | tool `dismiss_modal` | 7 | 8 | `dismissModalStr` 5 |

## 5. Findings

Each finding has an ID and a candidate class for Phase B (WRONG / BUG / THIN). Phase B decides the final class after reproduction. **[repro B]** marks findings that still need a live reproduction.

### 5.1 Contract breaks on the golden path

**A-01 `press Enter` may click a link instead of pressing Enter, and still report "Pressed Enter".** Candidate WRONG. [repro B]
- Before every `press <t> Enter`, the capability runs `probeSearchSubmit` (`cdp:28670-28674`).
- The probe returns the first visible `a[href]` on the whole page that looks like a search listing (`cdp:18118-18142`): the path is `/`, `/models`, `/datasets`, `/spaces`, `/posts` or ends in `/search`, and the URL has `q=` or `search=` (`cdp:13717-13736`), or the link text matches `see … results` (`cdp:13738-13740`). The probe does not check which element has focus.
- When a link matches, `pressStr` JS-clicks it (`submitSearchListing` `cdp:18232-18267`) and returns `Pressed Enter. Submitted search via <selector>` (`cdp:18114-18116`, `cdp:18274-18281`). No key event is sent, and the feedback policy becomes `report-only` (`cdp:18061-18063`).
- After a `fill` in a batch, on host `huggingface.co` the tool navigates to `/models?search=<filled>` by itself (`cdp:18153-18174`, `cdp:18191-18193`).
- This is intended and tested (`tests/search-submit.test.mjs:603-606`). It conflicts with `AGENTS.md:11-12` (never report a false success; ground results in observed evidence) and with this audit's rule that the tool must not decide on its own to click something else. Related open issue: #607.
- Repro sketch: a page with a form field plus any visible `<a href="/search?q=x">`. `fill` the field, then `press Enter`: expect the link navigation and no `keydown`.

**A-02 `select` does not accept `@ref`, but SKILL and the failure's own recovery say it does.** Candidate WRONG. [repro B]
- `SKILL.md:17`: "`click`, `fill`, `press`, `select`, `scroll`, or `dismiss-modal` with a fresh `@ref` or stable selector."
- The `select` capability passes the argument through unchanged (`cdp:28774-28779`), and `selectStr` calls `document.querySelector(<arg>)` (`cdp:20104-20105`). `@5` is not valid CSS.
- The failure is classified `invalid-selector`, and its Next is `cdp select <t> <css|#id|[data-testid]|@ref>` (`ar:772-791`, template `ar:780`). An agent that follows Next repeats the same failing call. The Next is also a template, not a command.
- The same SKILL sentence lists `press`, `scroll` and `dismiss-modal`, which take no element argument (synopses `cs:864`, `cs:865`, `cs:897`). This invites flags or arguments those commands do not have.

**A-03 MCP agents cannot run most of the `Next:` commands they are given.** Candidate WRONG (MCP surface).
- The served `run_command` allowlist contains only survivor spellings (`cs:940-942`, 27 spellings). Anything else is refused with `run_command command not allowlisted` (`mcp:111-118`).
- Next lines that point outside it: unclassified CLI errors → `cdp status <t>` (`cdp:32063-32068`); CDP timeouts → `status` (`cdp:32050-32054`); action failure defaults → `status` (`ar:475`, `ar:643`, `ar:746`); no input events or no navigation → `cdp jsclick` (`cdp:32021`, `cdp:32032`, `ar:560`, `ar:718`, `ar:759`); covered click → `overlay` (`ar:207`, `ar:284`); console or network deltas → `console` / `netlog` (`cdp:8511`, `cdp:8523`); cancelled navigation → `dialog` (`ar:313`); frame check → `frame` (`ar:1321`); `perceive --qa` → `report` (`cdp:30930`).
- Env-prefixed Next lines cannot be expressed through MCP either, because the `run_command` schema has no env field (`cs:796-812`). Examples: `CDP_BACKGROUND=0 cdp shot …` (`cdp:31499`), `CDP_BACKGROUND=0 cdp drag …` (`ar:634`), `XDG_RUNTIME_DIR=/tmp/cdp-rt …` (`cdp:31472`).
- This violates `AGENTS.md:24` ("Every error states the cause plus the next executable command") on the MCP surface. Hosts that prefer MCP: `hosts/cursor.md:3`, `hosts/openclaw.md:3`.

**A-04 Redaction gaps: the same value is masked in action receipts and printed raw by read commands.** Candidate WRONG for `cookies`; BUG/THIN for the rest. [repro B]
- `cookies` prints the first 30 characters of every cookie value, including HttpOnly session cookies; values shorter than 31 characters are printed whole (`cdp:20765-20778`). `checkpoint` redacts cookies by default (`cs:851`). The rule "cookie, JWT and Authorization are masked by default" is not met.
- `console` prints raw console text (`cdp:7071`, `cdp:7078`).
- `status` prints raw console text and exceptions (`cdp:7027`, `cdp:7038`) and the raw page URL (`cdp:6988`).
- The `perceive` header prints the raw page URL (`cdp:15912`).
- `list` prints the raw URL of every open tab, in text (`cdp:4972`) and JSON (`cdp:5000`).
- Action receipts redact the same data: console lines through `redactSensitiveString` (`cdp:8829`, `cdp:8835`), URLs through `redactUrl` (`cdp:9320-9323`), and the whole text receipt (`cdp:9427`).
- Repro sketch: a page that logs `Bearer eyJ…` and a tab URL with `?access_token=…`. Compare `click` receipt vs `console`/`status`/`list`/`perceive`.

**A-05 The guidance for attaching to the default profile contradicts itself across files.** Candidate WRONG (contradictory contract).
- `SKILL.md:22`: from Chrome 136 the default profile cannot enable CDP; use a persistent non-default daily dir or an isolated spawn.
- `references/commands.md:76`: recommends `spawn-debug-browser <browser> --daily-profile --port 9222`, then says 136+ and Edge ignore it on the default dir.
- `references/troubleshooting.md:39`: "Prefer `--daily-profile` over `chrome://inspect/#remote-debugging`."
- `references/commands.md:99`, `:113` (WSL section): the only correct prerequisite is the `chrome://inspect/#remote-debugging` toggle; do not suggest `--remote-debugging-port` restarts or separate profiles.
- Runtime recovery: "enable remote debugging on the existing browser via chrome://inspect/#remote-debugging" (`cdp:31553-31558`).
- `docs/daily-browser-cdp.md:47` lists the Chrome 144+ inspect toggle, with a per-connection Allow dialog, as a working interactive path.
- An agent gets a different first move depending on which file it opens.

**A-06 The MCP surface does not match what SKILL teaches.** Candidate WRONG (MCP-only hosts) / THIN.
- `eval` is a survivor (`SKILL.md:63`), but its MCP exposure is `none` (`cs:832`): no tool and no `run_command`.
- `viewport|resize` and `responsive-audit` are taught (`SKILL.md:17`, card `cdp:30707`), but they are neither served tools (filtered at `cs:968-972`) nor allowlisted.
- The MCP `wait_for` tool has no plain-selector form (`cs:685-702`, `mcp:425-447`). CLI and SKILL teach `waitfor <t> <selector> [ms]` (`cs:868`).
- The MCP `spawn_debug_browser` mapper reads `args.dailyProfile` (`mcp:465`), but the schema has `additionalProperties: false` and no such property (`cs:733-747`). The branch is dead.
- Two MCP gates disagree. A `tools/call` naming an unlisted tool (`report`, `overlay`, `viewport`, …) still runs, because the mapper table covers every catalog tool (`cs:1027-1032`). `run_command` with the same command is refused (`mcp:111-118`). An agent told `Next: cdp overlay <t>` could recover through the unlisted `overlay` tool, but nothing tells it that the tool exists.
- MCP tool descriptions (`cs:388-813`) never say when not to use the tool or which result field decides the next step.

### 5.2 Receipts, errors and help

**A-07 Two error classifiers, two output shapes, two Kind vocabularies, and Kinds chosen by matching substrings of the message.** Candidate THIN; one misclassification is WRONG-adjacent.
- Action path: `classifyActionFailureKind` (`ar:466-979`) prints `Error:` / `Kind:` / detail / `Next:` (`ar:1014-1021`). Kinds include stale-ref, covered, misdirected, click-no-change, disabled, overlay, wrong-frame, dom-rewrite, invalid-selector, selector, not-fillable, drag-*, no-input-events and timeout.
- CLI path: `buildCliErrorRecovery` (`cdp:31447-32075`, about 45 ordered branches) prints `Error:`, then a `Recovery:` block (`Kind`, `Strategy`, `Run`, `Then`, `Reason`), then `Next: … (Kind: …)` (`cdp:32077-32089`, `cdp:32163-32201`). Kind and the command are each printed twice: the missing-target error is 8 lines and 377 chars. Kinds include target-resolution, browser-cdp, stale-daemon, daemon-disconnect, hidden-tab, screenshot-capture, eval, pdf-viewer and assertion.
- No schema enumerates either vocabulary: `docs/schemas/action-receipt.v1.json` has no kind enum, and no `cli-error.v1` schema file exists. SKILL documents 6 kinds (`SKILL.md:18`, `:36`, `:40`).
- Probes (`__test__.buildCliErrorRecovery`):

  | cmd | message | Kind / Next |
  |---|---|---|
  | `eval` | `Uncaught Error: Field is required` (a page exception) | `usage` / `cdp help eval`, through the generic `includes('required')` branch `cdp:31936-31943` |
  | `nav` | `net::ERR_NAME_NOT_RESOLVED` | `unknown` / `cdp status <t>` |
  | `open` | `Invalid URL: file:///…` | `unknown` (open issue #587) |
  | `text` | `text: no element matched …` | `unknown` / `cdp status <t>` |

- Agents can branch only on the handful of documented kinds. `unknown` is common, and its Next (`status`) cannot run on MCP (A-03).

**A-08 Runtime output names 35 non-survivor commands, so the survivor card is not closed.** Candidate THIN; input to proposals.
- See §3.6. Every `perceive` header says "use clickxy with these values" (`cdp:15934`). `status` says "use 'console --all'" (`cdp:7029`). `fullshot` says "Use 'scanshot'" (`cdp:20179`). `diff-shot` points to `report` (`cdp:6224`, `cdp:6238`).
- `jsclick` contradiction: the card says "click --js is JS click" (`cdp:30703`), SKILL says `click --js` is a flag and not a separate command (`SKILL.md:17`), and the docs contract forbids advertising `jsclick` (`scripts/check-docs-contract.mjs:447-449`). Recoveries still print `cdp jsclick …` (A-03 lists the sites).
- Typo suggestions search all 82 commands (`cdp:31192-31221`): `cdp clik` suggests "click / clock", which surfaces a hidden mutating command.

**A-09 `Next:` lines are not executable as printed.** Candidate THIN; WRONG against `AGENTS.md:24`.
- Placeholder templates: `commandUsageTemplate` (`cdp:31357-31430`), e.g. `cdp click <target> <selector|@ref>`; `ar:780`.
- A typo gives `Next: cdp click (Kind: usage)` with no target, and running that line fails next with "target ID required" (measured).
- The binary is `bin/chrome-cdp` (`package.json` `bin`), but every Next line, the card (`cdp:30697`) and `SKILL.md:36` say `cdp`. SKILL never states that `cdp` means `bin/chrome-cdp`.
- POSIX env prefixes (`CDP_BACKGROUND=0 …`, `CDP_PORT=… …`, `XDG_RUNTIME_DIR=… …`) are never rewritten for PowerShell: there is no `$env:` form anywhere in `cdp.mjs`. `SKILL.md:10` sends Windows users to PowerShell with `chrome-cdp.cmd`.

**A-10 SKILL plus `cdp help` is not enough to learn the golden-path flags.** Candidate THIN.
- `cdp help perceive` prints `perceive <target> [flags] [--format json]` and nothing else (`cs:829`, `cdp:30724-30736`).
  - `--since-action` is in the killer path and in receipts (`cdp:8560`, `cdp:8675`), but not in SKILL or help.
  - `-F/--frame`, `-s`, `--last` and `--cards` are not discoverable.
- Truncated one-line summaries: `doctor` ("…skill install path,", `cs:822`) and `dismiss-modal` ("…then Escape) —", `cs:897`).
- `SKILL.md:57` sends readers "for more depth" to references/commands.md (165,619 chars, about 41k tokens by chars/4).

**A-11 `text` has no default size bound.** Candidate THIN. [measure in token-perf]
- Unscoped `text` returns all document text and only appends a hint above 2,000 chars (`cdp:22409-22415`).
- `text --auto` returns the whole `main`/`article` text with no cap (`cdp:22367-22374`). SKILL teaches it (`SKILL.md:16`).

**A-12 The same verb has a different shape on MCP and the CLI.** Candidate THIN. [measure in token-perf]
- MCP `perceive` always adds `--format json`, and adds `--adaptive` unless the caller passes `last` or `adaptive: false` (`mcp:298-311`). The CLI default is text without adaptive (`cdp:13596-13601`).
- MCP `click`, `fill`, `press`, `navigate` and `dismiss_modal` force `--format json` (`mcp:334-371`, `mcp:417-424`); the CLI default is the text receipt.
- `createMcpToolResult` returns that JSON both as text content and as `structuredContent` (`mcp:671-684`). A host that forwards both pays for it twice.
- `AGENTS.md:23` promises a one-line success receipt, but `formatActionText` (`cdp:9109-9211`) can emit dispatch, target, outcome, receipt, verdict, settle, console/network summaries, a `---` diff block, Next and Hint.

### 5.3 Dead code and agent-unreachable commands

**A-13 The daemon wiring is not exercised by the default gate.** Candidate THIN.
- `runDaemon` (`cdp:27904`) and every capability (`cdp:28334-28891`) have 0 in-process hits. That layer is where argument shapes reach the implementations, and where A-01 and A-02 live.
- Implementations with 0 hits: `typeStr` (`cdp:17955`), `cookiesStr` (`cdp:20765`), `cookieSetStr` (`cdp:22088`), `historyNavStr` (`cdp:23263`, `back`/`forward`), `annotshotStr` (`cdp:21198`, `shot --annotate`).
- No test spawns a real `_daemon` against a fake browser.
- `npm run smoke:live` (`scripts/live-smoke.mjs`) drives 30 commands but no `select`, `scroll`, `elshot`, `cascade`, `nav`, `stop` or `spawn-debug-browser`, all survivors.

**A-14 The registration tax is at least 14 places (§2).** Candidate THIN; architecture input.

**A-15 Dead runtime and catalog paths.** Candidate THIN.
- The full 82-command help (`CLI_HELP_LAYOUT` `cdp:29862-30355`, `CLI_HELP_TEMPLATE` `cdp:30357-30643`, about 780 lines) is rendered and validated on every CLI start (`cdp:30717`), but only `__test__` reads it (`cdp:33823`). Users see the 20-line card (`cdp:30718`). Open issue #600 reports startup compile cost.
- The 13 filtered-out MCP tools are not dead. `tools/list` leaves them out, but `MCP_TOOL_MAPPER_BY_NAME` (`cs:1027-1032`) still maps every catalog tool name. A `tools/call` for `report`, `overlay`, `viewport` or `select_target` therefore still runs (checked: `buildMcpToolCommand('report', { target })` returns `report <t> --compact --format json`), through the mapper branches at `mcp:290-297`, `mcp:312-326`, `mcp:342-351`, `mcp:372-416`, `mcp:454-459` and `mcp:470-504`. `run_command` refuses the same commands (A-06). So the survivor gate on MCP only shapes the listing; it does not limit what can be called.
- 45 of the 72 declared `run_command` spellings are filtered out (`cs:342-355` vs `cs:940-942`).

**A-16 41 commands cannot be reached from SKILL, `cdp help` or runtime output.** Candidate input to proposals; not a bug by itself. Reach "none" in §4: `tab-group`, `broadcast`, `attach`, `forget`, `current`, `snap`, `controls`, `eval64`, `call`, `wait`, `keepalive`, `diff-shot`, `net`, `mock`, `clock`, `throttle`, `summary`, `checkpoint`, `restore`, `replay`, `qa`, `verify-click`, `type`, `hover`, `drag`, `loadall`, `fullshot`, `scanshot`, `styles`, `components`, `cookies`, `cookieset`, `cookiedel`, `evalraw`, `emulate`, `upload`, `table`, `forward`, `closetab`, `record`, `repeat`.
- Several cover required scenario types that the taught surface cannot do:
  - File input: `upload`.
  - Hover menus: `hover`.
  - Load-more and virtualized lists: `loadall`, `table --collect`.
  - Visual diff: `diff-shot`.
- The rest of the list is a candidate for removal from agent-facing surfaces. The proposals phase decides; external contracts may need compatibility aliases.

**A-17 Duplicate families.** Proposal input.

| Family | Members | Literal overlap |
|---|---|---|
| Pixels | `shot`, `shot --annotate`, `elshot`, `fullshot`, `scanshot`, `diff-shot` | `fullshot` recommends `scanshot` (`cdp:20179`) |
| Click | `click`, `click --js`, `click --pointer`, `jsclick`, `clickxy`, `verify-click`, named click | `jsclick` = `click --js` (`cdp:31057-31092`); `verify-click` = click + assertion window (`cdp:28814-28843`) |
| Script | `eval`, `eval --b64`, `eval64`, `call`, `evalraw` | `eval64` = `eval --b64` (`cs:833`) |
| Look | `perceive` (+`--qa`, `--cards`, `-F`), `snap`, `summary`, `controls`, `text`, `html`, `status`, `overlay`, `frame` | `snap` prints the raw AX tree that `perceive` also reads (`cdp:5109-5112`, `cdp:15701`) |
| Type | `fill`, `type` | `type` = `Input.insertText` at focus (`cdp:28784-28789`) |
| Network | `net`, `netlog` | — |
| Wait | `wait`, `waitfor`, flow `wait dom stable` | flow's `wait` keyword shadows the `wait` command (#616) |
| QA | `qa`, `responsive-audit`, `verify-click` | — |
| Handoff | `report`, `record-actions`, `export-playwright`, `replay` | — |
| Composite | `batch`, `flow`, `repeat`, `broadcast` | — |
| Alias | `use`, `attach`, `forget`, `current` | `attach` = `use` + `--port` (`cdp:33172-33210`) |

**A-18 Published schemas do not constrain what agents branch on.** Candidate THIN.
- The runtime emits 76 schema ids; 5 schema files exist.
- `action-receipt.v1.json` and `doctor.v1.json` set `additionalProperties: true` and enumerate no outcome or kind values.
- No test, script or runtime file references any `docs/schemas/*.json`.

### 5.4 Capability gaps that need live checks

**A-19 Cross-origin iframes are probably unreachable.** Candidate THIN/BUG. [repro B]
- `cdp.mjs` never calls `Target.setAutoAttach`.
- `perceive --frame` uses `Accessibility.getFullAXTree({frameId})` and `Page.createIsolatedWorld({frameId})` on the page session (`cdp:15690-15691`, `cdp:13231-13237`), which cannot reach an out-of-process frame.
- The frame workflow relies on the non-survivor `frame` and the undocumented `-F`.

**A-20 `scroll` cannot scroll a nested container by direction.** Candidate THIN. [repro B]
- `scroll down|up|x,y` moves only the document scrolling element (`cdp:18583-18596`).
- `--scroll-container` works only with `to top|to bottom` (`cdp:18580-18582`).

**A-21 The `flow` DSL tokenizer.** Candidate BUG (known).
- Steps are split on `;` and then on whitespace, with no quoting (`cdp:24641-24665`). Open issues #616 (`wait 2000`) and #617 (`;` inside `eval`).

**A-22 `diff-shot` computes the pixel diff inside the user's page.** Candidate THIN. [measure B]
- `diffShotCompareScript` (`cdp:6141-6215`) runs in the page through `Runtime.evaluate` with two base64 PNGs, and compares pixels exactly (`cdp:6184`).

### 5.5 Docs vs code

**A-23 Stale or vacuous docs and checks.** Candidate THIN.
- `docs/architecture/runtime-v3.md:65-67` and `:78` say in the present tense that 68 target commands execute through the dispatcher; the catalog now has 69 (`drag` was added), and 82 commands in total. Lines 16, 160 and 174-206 describe history and can stay.
- The docs-contract "leftover" check uses a plain substring test (`scripts/check-docs-contract.mjs:589`), so it passes for short names regardless (`net` matches "network").
- The flag census found no documented `cdp` flag missing from the runtime. The unmatched flags all belong to other tools: benchmark scripts (`--rounds`, `--types`, …), `session.mjs` (`--script`, `--args`), `usage-report` (`--windows`, `--since`), and CSS inside an `inject` example (`--primary`). **OK.**

**A-24 Order-dependent test failure.** Candidate BUG (test infrastructure). [repro B]
- Two tests in `tests/issue-358-first-step.test.mjs` fail only under default parallelism. The error is `cdp_isolated_occupant` for a fixture profile `/tmp/chrome-cdp-ex-edge-debug-profile-9222`.
- `vitest.config.js:11-17` and `:21-24` give all workers one shared runtime dir per run.
- CI's Windows job uses `--maxWorkers=2`, where the tests pass.

**A-25 Benchmark-shaped heuristics in the general runtime.** Candidate THIN; root of A-01.
- The `huggingface.co` host check and the `/models` path (`cdp:18163-18165`, `cdp:13734`).
- The `see … results` text rule (`cdp:13739`).
- Ranking that puts search-listing links first in perceive's visible controls (`cdp:13781-13792`).
- Special cases for single benchmark shapes inside the receipt formatter: the leftover AX scroll branches in `formatActionText` (`cdp:9118-9209`) and the fill typeahead extraction (`cdp:9234-9298`).

### 5.6 Checked and OK (not to be reopened)

- **O-1** Catalog → dispatcher → handler exactness is enforced before the daemon runs anything: `preflightDaemonApplication` (`cdp:27741-27776`), `snapshotOwners`/`snapshotHandlers` (`lib/command-dispatch.mjs:35-67`), exact-cover capabilities (`lib/daemon-read-handlers.mjs:67-77`, `lib/daemon-action-handlers.mjs:55-62`). There is no orphan target handler and no unhandled target command.
- **O-2** The `tools/list` answer and the `run_command` allowlist are a checked subset of the survivors (`cs:983-1022`). That check does not cover `tools/call` by name (A-06), and hints still point outside the subset (A-03).
- **O-3** Hidden-tab capture matches `SKILL.md:36` (plain capture up to 3 s, focus-emulation retry, then `Kind: hidden-tab`; `cdp:5848-5919`). The worst case is about 6 s, not "about 3 s".
- **O-4** The card and SKILL list every survivor, and the docs contract checks it (`scripts/check-docs-contract.mjs:439-460`, `:577-594`).
- **O-5** Documented `cdp` flags all exist in the runtime (A-23 flag census).

## 6. Inputs for the next phases

- **Phase B reproductions:** A-01, A-02, A-04, A-19, A-20, A-22, A-24, and the A-07 `eval` misclassification on a live page.
- **Phase B hot spots not covered here:**
  - perceive browser-side CPU, bytes and `@ref` stability;
  - covered-click refusal vs blind retries;
  - daemon socket takeover, restart, UTF-8 framing and multi-tab;
  - MCP image block vs CLI receipt;
  - dialog, download and file input;
  - WSL2, Electron and non-default user-data-dir doctor guidance.
- **Token/perf measurements:**
  - `perceive` default vs `-C -d 8` vs `--since-action` vs `text --auto` (A-11);
  - action receipt text vs MCP JSON vs `structuredContent` (A-12);
  - error block size (A-07, A-09);
  - daemon cold start, second command, and tab switch (existing `docs/perf/` and `benchmark:slice1`; #600, #611).
- **Open issues that overlap these findings:** #587 (A-07), #598 (perceive `-C` duplicates), #599 (stale-ref Next), #600 (A-15), #601 (covered Next), #607 (A-01), #616/#617 (A-21), #629/#630 (overlay Next).
