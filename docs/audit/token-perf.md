# Token and latency measurements

Phase B measurements for chrome-cdp-ex 2.21.0 at `21e96b5`, taken 2026-10-09 on the setup in [findings.md](findings.md#setup): Windows 11, Node v24.21.0, headless Chrome 154 on its own profile and port, fixture server `docs/audit/fixtures/phase-b-server.mjs`.

- Raw data: [token-perf.json](token-perf.json), from `CDP_PORT=<test port> node docs/audit/measure-token-perf.mjs <out.json>`. MCP rows come from `docs/audit/mcp-probe.mjs`.
- "Chars" is what an agent reads from one call: stdout plus stderr.
- Tokens are **estimates**: chars/4 for text, and width × height / 750 for an image (Anthropic's published approximation). No tokenizer was run.
- Public pages change; their rows describe that day's pages. Each page was measured once, the latency rows are medians of 7 runs unless noted.

## 1. Context loaded before the first command

| Item | Size | Est. tokens | When it enters context |
|---|---:|---:|---|
| `skills/chrome-cdp-ex/SKILL.md` | 7,401 chars (frontmatter 1,410) | ~1,850 | whenever the skill triggers |
| `cdp help` survivor card | 1,911 chars, 38 lines | ~480 | when the agent asks for help |
| `skills/chrome-cdp-ex/hosts/*.md` | 433–797 B each | 110–200 | per host integration |
| MCP `tools/list` (14 tools) | 10,999 B | ~2,750 | at every MCP session start |
| `references/commands.md` | 166,228 B | ~41,500 | when SKILL.md:57 sends the agent to "exhaustive command docs" |
| `references/troubleshooting.md` | 17,338 B | ~4,300 | on attach or recovery trouble |
| `references/recipes.md` | 10,016 B | ~2,500 | on demand |

## 2. Reading a page

| Page | `perceive` | `perceive -C -d 8` | `--since-action` after `scroll down` | `text --auto` | `text` | perceive ÷ text --auto |
|---|---:|---:|---:|---:|---:|---:|
| local todo | 493 (~123 t) | 712 | 281 | 35 | 72 | 14.1 |
| local overlay | 416 (~104 t) | 608 | 277 | 50 | 50 | 8.3 |
| local iframe-host | 435 (~109 t) | 541 | 285 | 58 | 58 | 7.5 |
| local spa | 418 (~105 t) | 651 | 273 | 38 | 38 | 11.0 |
| Wikipedia "Web browser" | 71,566 (~17,900 t) | 72,415 | 718 | 19,316 (~4,800 t) | 19,728 | 3.7 |
| GitHub repo page | 23,620 (~5,900 t) | 24,706 | 853 | 9,368 (~2,300 t) | 9,663 | 2.5 |
| Hacker News front page | 3,188 (~800 t) | 3,650 | 427 | 4,127 (~1,000 t) | 4,285 | 0.8 |
| MDN "Fetch API" | 30,632 (~7,700 t) | 31,264 | 331 | 2,784 (~700 t) | 3,054 | 11.0 |

All values are chars unless marked `t` (estimated tokens).

- On the public content pages, `perceive` costs 2.5–11 times `text --auto`. Most of the difference is navigation chrome: MDN's tree lists 97 links and 8 buttons around 2.8 K chars of article.
- Hacker News is the exception because `perceive` stops after 5 table rows (T-02): the 3,188 chars cover 2 of 30 stories.
- `-C -d 8` adds 106–1,086 chars over plain `perceive` on these pages.
- After an action, `perceive --since-action` costs 1.0–3.6 % of a full `perceive` on Wikipedia, GitHub and MDN, and 13 % on HN. On the small local pages the fixed header (about 240 chars) dominates both, so the diff is 57–67 % of a full perceive.
- `text` has no cap (T-01): 458,890 bytes for `/cjk.html` in one call.

## 3. Screenshots

| Page | `shot` chars | PNG | `scanshot` ms | `scanshot` chars | PNGs total | `elshot h1` chars |
|---|---:|---:|---:|---:|---:|---:|
| local todo | 246 | 14 KB | 352 | 302 | 14 KB | 271 |
| local overlay | 246 | 10 KB | 363 | 302 | 10 KB | 269 |
| Wikipedia | 246 | 196 KB | 3,196 | 2,239 | 1,538 KB | 284 |
| GitHub repo | 246 | 116 KB | 2,020 | 1,455 | 645 KB | 273 |
| Hacker News | 246 | 110 KB | 691 | 495 | 210 KB | 276 (exit 1: no `h1`) |
| MDN | 246 | 171 KB | 2,425 | 1,647 | 1,035 KB | 269 |

- The CLI returns a path, so a `shot` costs the agent about 60 text tokens until it opens the image.
- MCP `screenshot` inlines the PNG as an image block (13,268 base64 chars for `/overlay.html`) beside a 245-char text block. A 1252×799 viewport image is about 1,330 tokens by the formula above, whatever the page. On Wikipedia that is about 7 % of the text tokens a `perceive` costs.
- `scanshot` grows with page height (2–3 s and 0.6–1.5 MB on long pages) and its output lists every segment path.
- `diff-shot` at 1252×799: 0.31 s per call (findings O-06).

## 4. Receipts and errors

| Case | CLI text | CLI `--format json` | MCP `tools/call` |
|---|---:|---:|---:|
| `click` that works (`Accept all`) | 79 | 5,960 | not measured |
| `click` refused, element covered | 313 (stderr) | 8,278 | 15,761 B: text 8,277 + `structuredContent` 6,454 |
| `scroll down` | 76–79 | | |
| MCP `perceive` (overlay page) | | | 3,719 B: text 1,915 + `structuredContent` 1,432 |
| MCP `report` (unlisted tool) | | | 27,220 B: the same 12,747 chars as text and as `structuredContent` |
| `run_command` refusal | | | 102–105 B JSON-RPC error |

JSON receipt fields, in chars. "Role" is this audit's reading of what each field is for; which fields agents actually read is Phase D's measurement.

| Field | Click OK | Click refused | Role |
|---|---:|---:|---|
| `dispatch` | 28 | 281 | decision: did it send, and the error |
| `outcome` | 164 | 256 | decision |
| `verdict` | 340 | 480 | decision |
| `nextSteps` | 81 | 123 | decision |
| `nextHint` | 56 | 35 | decision, repeats `nextSteps[0]` |
| `effects` | 1,894 | 2,908 | evidence: AX diff, console, network |
| `receipt` | 781 | 1,289 | restates outcome, verdict and next |
| `recommendation` | 401 | 335 | restates next |
| `target` | 306 | 261 | echo of the input and page |
| `targetResolution` | 266 | 266 | echo |
| `settle`, `schema`, `action` | 60 | 60 | metadata |

The decision fields come to 669 chars (11 %) of the 5,960-char OK receipt and 1,175 chars (14 %) of the refused one. The text receipt carries the same decision in 79 and 313 chars.

## 5. Latency

| Step | Median ms |
|---|---:|
| `node -e 0` (process floor) | 28 |
| `help` | 81 |
| `list` | 93 |
| `list` through `bin/chrome-cdp` | 129 |
| `eval <t> 1`, daemon running | 104 |
| `eval <t> 1` through `bin/chrome-cdp` | 139 |
| `eval` alternating between two tabs with running daemons | 104 |
| `eval <t> 1` right after `stop <t>` (cold daemon), n=3 | 442 (439–448) |
| `perceive`, first / warm, local pages | 129–157 / 110–117 |
| `perceive`, first / warm, public pages | 184–317 / 147–245 |
| `open <url>`, local pages (n=1 each) | 2,155–2,283 |
| `open <url>`, public pages (n=1 each) | 2,364–3,481 |

- `bin/chrome-cdp` adds 35–36 ms per call, close to the 33 ms in #600.
- Switching between tabs whose daemons are running costs nothing extra.
- A cold daemon adds about 340 ms to the first command on a tab.
- `open` spends a fixed 1.5 s polling for a URL it has not navigated to yet (B-13): about two thirds of a local `open`.
- docs/perf/2026-09-30-cli-preamble.md measured warm `eval` at 228 ms of process time on a quiet machine of the same OS and 293 ms in `benchmark-cli-overhead`; this run's 104 ms is wall time seen by the parent process on another day, so the two are not a controlled comparison.

## 6. Per-task arithmetic

Text an agent reads (chars, estimated tokens in brackets), using the rows above:

| Task | Path | Chars |
|---|---|---:|
| Read the Wikipedia article | `open` + `perceive` (SKILL.md golden path) | 99 + 71,566 = 71,665 (~17,900) |
| Read the Wikipedia article | `open` + `text --auto` (open's own recommendation) | 99 + 19,316 = 19,415 (~4,850) |
| Click and confirm, local page | `click` + `perceive --since-action` | 79 + 277 = 356 (~90) |
| Click and confirm, local page | `click --format json` | 5,960 (~1,490) |
| Covered click, CLI | refused click + `click --js` retry (#601) | about 313 + 79 |
| Covered click, MCP | refused click | 15,761 B (~3,900) |
