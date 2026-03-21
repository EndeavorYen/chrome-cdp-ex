# Design: Reduce Agent Screenshot Overuse

**Date:** 2026-03-21
**Status:** Draft
**Problem:** Agents default to screenshots for visual verification even when structured text (perceive) would be more efficient and accurate. Screenshots are a "translation" layer (semantic → pixels → vision model → guessed semantics) that loses information. Structured text is zero-loss direct transfer.

## Root Cause Analysis

1. **perceive can't answer visual-style questions** — layout annotations only cover landmark elements (ENRICHED_ROLES: banner, nav, main, heading, table, etc.). Table cells, buttons, badges — the elements most often styled conditionally — get zero visual metadata. When an agent asks "did my conditional coloring work?", perceive has no answer → screenshot is the only option.

2. **SKILL.md guidance is rule-based, not scenario-based** — Multiple "DO NOT use screenshot" warnings scattered across the file. These read as prohibitions but don't answer the agent's real question: "I just changed CSS — how do I confirm it worked?" Without a concrete alternative workflow, agents fall back to what they know.

## Design

Two complementary changes:

### Part 1: Smart Visual Annotations in perceive (cdp.mjs)

Extend perceive's browser-side JS to detect **style anomalies** on leaf-level elements — cells, buttons, badges — not just landmarks.

#### Mechanism: Sibling-Relative Anomaly Detection

For each table in the page:

1. Collect `getComputedStyle` for all visible `td`/`th` cells: `backgroundColor`, `color`, `fontWeight`
2. Compute **baseline** per column (most common value among cells in that column)
   - Cells with `colspan` are excluded from baseline computation (they span multiple columns and skew the majority)
   - For small tables (< 4 data rows), skip baseline and report all non-default/non-transparent styles directly
3. Mark cells that **deviate from baseline** with style hints:
   - `bg:rgb(...)` — background differs from column majority
   - `bold` — fontWeight > 400 when majority is normal
   - `color:rgb(...)` — text color differs from column majority
4. Key each hint by **cell text content** (truncated to 50 chars), not positional index — this avoids DOM/AX tree ordering mismatches caused by `aria-hidden`, colspan, or ARIA grid patterns using `div[role="cell"]`

Non-table visual annotations are deferred to a future iteration to keep initial scope tight. The table cell case covers the primary screenshot-overuse scenario.

#### Data Flow

```
Browser-side eval (existing perceive JS)
  └─ NEW: styleHints collector
       └─ Scan tables → per-cell anomaly map keyed by (tableIdx, cellText)
            cellText = cell's textContent.trim().slice(0, 50)
  └─ Return styleHints alongside existing layoutMap

Node-side AX tree renderer (visit function in perceiveStr)
  └─ When rendering [cell] nodes inside a table context:
       ├─ Extract cell text from AX node name/value
       ├─ Look up styleHints[(tableIdx, cellText)]
       └─ Append matching hints: "bg:rgb(...) bold color:rgb(...)"
```

**Matching strategy detail:** The browser-side JS assigns each table an index (document order, 0-based). For each cell, it computes `cellText = td.textContent.trim().slice(0, 50)`. The hint key is `"${tableIdx}:${cellText}"`. On the Node side, `visit()` already tracks `tableAncestorId` — we add a `tableIdxMap` (Map of nodeId → index, incremented each time a new table role is encountered). When rendering a cell, the lookup key is `"${tableIdx}:${cellName}"` where `cellName` is the AX node's `name.value` (which matches textContent for table cells). If no match is found, the cell renders without hints — safe fallback.

#### Output Example

Before (current):
```
[table] Department Health  ↕400px
  [row] header
    [columnheader] Department
    [columnheader] GPU Hours
    [columnheader] Failure Rate
  [row]
    [cell] LLM Technology
    [cell] 1,234
    [cell] 33.3%
  [row]
    [cell] LLM Software Engineering
    [cell] 890
    [cell] 70.0%
  ... more rows truncated
```

After (with style hints):
```
[table] Department Health  ↕400px
  [row] header
    [columnheader] Department
    [columnheader] GPU Hours
    [columnheader] Failure Rate
  [row]
    [cell] LLM Technology  bold
    [cell] 1,234  bold
    [cell] 33.3%  bg:rgb(255,235,200)
  [row]
    [cell] LLM Software Engineering
    [cell] 890
    [cell] 70.0%  bg:rgb(255,200,200)
  ... more rows truncated
```

The agent sees "33.3% has amber background, 70.0% has red background, first row is bold" — no screenshot needed.

#### Token Budget Controls

- Per table: respect existing `TABLE_ROW_LIMIT` (5 rows) — style hints only on rendered rows
- Per cell: max 3 hints (bg + bold + color)
- Non-table elements: max 50 scanned
- Zero overhead when no anomalies detected (nothing added to output)
- Total styleHints payload: cap at 100 entries across all tables

#### Implementation Location

All changes in `skills/chrome-cdp/scripts/cdp.mjs`:

1. **Browser-side eval in `perceiveStr`** (the large eval block inside `perceiveStr` that builds `layoutMap`): Add styleHints collection after the existing layoutMap collection. Same eval block, returned alongside layoutMap in the JSON.

2. **`visit()` helper inside `perceiveStr`**: When rendering cell/row nodes inside a table context (already tracked via `tableAncestorId`), add a `tableIdxMap` to track table indices, look up styleHints by `(tableIdx, cellText)`, and append annotations to the line.

3. **No changes to `formatAxNode`** — style hints are appended in `visit()` after the normal line is built, same pattern as existing layout annotations.

### Part 2: Scenario-Driven SKILL.md Guidance

#### Replace scattered prohibitions with a decision tree

Add a new section **"Verifying changes after actions"** after the existing "Observation workflow" section:

```markdown
### Verifying changes after actions

| What you need to verify | How to verify | Why not screenshot |
|---|---|---|
| Content/structure changed | `perceive` — check AX tree | Text is 100% accurate from DOM |
| CSS styles applied (color, bold, bg) | `perceive` — style hints show bg/color/bold | Reads computed styles directly |
| Element exists/visible | `perceive` — node presence + visibility | Structured data, not pixel guessing |
| Layout/spacing correct | `perceive` — height, display, gap annotations | Exact px values |
| Visual polish/aesthetics | `elshot <selector>` on specific component | Targeted, only for subjective quality |
| Animation/transition effect | `elshot <selector>` before and after | Only case needing visual capture |
```

Key message: **"perceive now tells you colors, bold, and style anomalies. You don't need a screenshot to verify CSS changes."**

#### Consolidate redundant warnings

Current state: 6+ separate "don't use screenshot" warnings scattered across SKILL.md.

Target state:
- **One authoritative section** (the decision tree above) that explains WHEN to use what
- **One-line references** elsewhere: "See 'Verifying changes' for which tool to use"
- Remove repeated DO NOT / CRITICAL warnings about screenshots — they become noise

#### Update workflow examples

Revise the existing workflow sections (Debugging, Form interaction, Visual comparison) to reference the new perceive capabilities:

```markdown
### Debugging workflow
1. `perceive <target>` — structure + console errors + style anomalies
2. If console errors: `console <target>` for stack traces
3. If visual fix needed: check perceive style hints first;
   `elshot` only for subjective visual quality

### Visual comparison workflow
1. `perceive` both pages — compare structure, style hints
2. `elshot` specific sections only if perceive shows identical structure
   but you need subjective aesthetic comparison
```

## What This Does NOT Change

- `shot`, `scanshot`, `elshot`, `fullshot` commands remain fully available and easy to use
- No artificial friction added to screenshot commands
- perceive output format stays backward-compatible (new hints are appended, never replace existing output)

## Success Criteria

After this change, an agent doing "add conditional coloring to a table" should:
1. Write the code
2. Run `perceive` to verify
3. See `bg:rgb(255,200,200)` on the affected cells in the perceive output
4. Confirm the coloring works **without any screenshot**

Screenshot (`elshot`) should only appear when the agent needs to judge subjective visual quality (spacing, alignment, aesthetic polish) that can't be expressed as structured data.

## Risks

- **Style hint / AX tree text mismatch**: Matching uses cell text content. AX node `name.value` usually matches `textContent.trim()` for table cells, but can diverge if the cell contains complex inner structure (e.g., nested spans with aria-label). Mitigation: if no styleHint match is found, the cell renders normally without hints — safe silent fallback, no incorrect annotations.
- **Token bloat on style-heavy pages**: Pages with many conditionally-styled cells (e.g., a heatmap table) could generate many hints. Mitigation: the 100-entry cap and TABLE_ROW_LIMIT (5 rows) bound this.
- **Baseline detection inaccuracy**: On small tables (< 4 data rows), "majority" is less meaningful. Mitigation: skip baseline detection for small tables and report all non-default/non-transparent styles directly.
- **Duplicate cell text in same table**: Two cells with identical text (e.g., multiple "0%") would collide on the same key. Mitigation: append column index from the DOM as tiebreaker: key = `"${tableIdx}:${cellText}:${colIdx}"`. On the AX side, track cell position within the current row to reconstruct colIdx.
