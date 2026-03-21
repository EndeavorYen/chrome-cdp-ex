# Reduce Agent Screenshot Overuse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `perceive` output include style anomalies on table cells (bg, bold, color) so agents can verify CSS changes without screenshots, and rewrite SKILL.md guidance from rule-based prohibitions to scenario-driven decision trees.

**Architecture:** Browser-side JS in `perceiveStr`'s eval collects per-cell computed styles and detects anomalies via sibling-relative baseline comparison. Results are keyed by `"tableIdx:cellText:colIdx"` and consumed by the Node-side `visit()` function when rendering `[cell]` AX nodes. SKILL.md is restructured to guide agents by verification scenario rather than blanket prohibitions.

**Tech Stack:** Pure ESM Node.js 22+, Chrome DevTools Protocol (CDP), no dependencies.

**Spec:** `docs/superpowers/specs/2026-03-21-reduce-screenshot-overuse-design.md`

**Testing note:** This project has no test suite — it's a single-file CLI tool requiring a live Chrome browser. Each task includes manual verification steps using a real browser page with a styled table.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `skills/chrome-cdp/scripts/cdp.mjs` | Modify | Add styleHints collection in browser-side eval + consumption in `visit()` |
| `skills/chrome-cdp/SKILL.md` | Modify | Restructure observation guidance, add verification decision tree, update workflows |

---

### Task 1: Add styleHints collection in browser-side eval

**Files:**
- Modify: `skills/chrome-cdp/scripts/cdp.mjs` — the browser-side eval inside `perceiveStr` (the IIFE starting ~line 575 that builds `layoutMap` and returns JSON)

This task adds the styleHints data collection. No rendering yet — just getting the data out of the browser.

- [ ] **Step 1: Add styleHints collector after layoutMap in the browser-side eval**

Inside the `perceiveStr` eval IIFE, after the `layoutMap` collection loop (after the line `if (++count >= 150) break;` and its closing `}`), add the styleHints collector. Insert before the `// Focused element` comment:

```javascript
      // === Style hints: detect visual anomalies on table cells ===
      const styleHints = {};
      let styleHintCount = 0;
      const tables = document.querySelectorAll('table, [role="grid"], [role="treegrid"]');
      for (let ti = 0; ti < tables.length && styleHintCount < 100; ti++) {
        const tbl = tables[ti];
        const rows = tbl.querySelectorAll('tr, [role="row"]');
        // Separate header rows from data rows
        const dataRows = [];
        for (const row of rows) {
          const firstCell = row.querySelector('td, [role="cell"], [role="gridcell"]');
          if (firstCell) dataRows.push(row);
        }
        if (dataRows.length === 0) continue;
        const smallTable = dataRows.length < 4;

        // Collect per-column baselines from all data cells
        const colBgs = {}, colWeights = {}, colColors = {};
        for (const row of dataRows) {
          const cells = row.querySelectorAll('td, th, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]');
          let ci = 0;
          for (const cell of cells) {
            if (cell.colSpan > 1) { ci += cell.colSpan; continue; }
            const cs = window.getComputedStyle(cell);
            const bg = cs.backgroundColor;
            const fw = parseInt(cs.fontWeight) || 400;
            const clr = cs.color;
            if (!colBgs[ci]) { colBgs[ci] = {}; colWeights[ci] = {}; colColors[ci] = {}; }
            colBgs[ci][bg] = (colBgs[ci][bg] || 0) + 1;
            colWeights[ci][fw] = (colWeights[ci][fw] || 0) + 1;
            colColors[ci][clr] = (colColors[ci][clr] || 0) + 1;
            ci++;
          }
        }

        // Find majority value per column
        function majority(counts) {
          let best = null, bestN = 0;
          for (const [v, n] of Object.entries(counts)) { if (n > bestN) { best = v; bestN = n; } }
          return best;
        }
        const baseBg = {}, baseWeight = {}, baseColor = {};
        for (const ci of Object.keys(colBgs)) {
          baseBg[ci] = majority(colBgs[ci]);
          baseWeight[ci] = majority(colWeights[ci]);
          baseColor[ci] = majority(colColors[ci]);
        }

        // Emit hints for cells that deviate from baseline
        for (const row of dataRows) {
          const cells = row.querySelectorAll('td, th, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]');
          let ci = 0;
          for (const cell of cells) {
            if (cell.colSpan > 1) { ci += cell.colSpan; continue; }
            const cs = window.getComputedStyle(cell);
            const hints = [];

            const bg = cs.backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              if (smallTable || bg !== baseBg[ci]) hints.push('bg:' + bg);
            }
            const fw = parseInt(cs.fontWeight) || 400;
            if (fw > 400) {
              const baseW = parseInt(baseWeight[ci]) || 400;
              if (smallTable || fw !== baseW) hints.push('bold');
            }
            const clr = cs.color;
            if (clr && clr !== 'rgb(0, 0, 0)') {
              if (smallTable || clr !== baseColor[ci]) hints.push('color:' + clr);
            }

            if (hints.length > 0 && styleHintCount < 100) {
              const text = cell.textContent.trim().slice(0, 50);
              const key = ti + ':' + text + ':' + ci;
              styleHints[key] = hints.join(' ');
              styleHintCount++;
            }
            ci++;
          }
        }
      }
```

- [ ] **Step 2: Include styleHints in the returned JSON**

In the same eval, change the `return JSON.stringify({...})` line to include `styleHints`:

```javascript
      return JSON.stringify({
        title: document.title, url: window.location.href,
        vw, vh, scrollY, scrollMax,
        counts, focused: focusDesc, layoutMap, styleHints
      });
```

- [ ] **Step 3: Verify the eval doesn't break existing perceive output**

Run `perceive` on any open tab and confirm it still works. The new `styleHints` field is collected but not rendered yet — output should be identical to before.

```bash
node scripts/cdp.mjs perceive <target>
```

Expected: normal perceive output, no errors.

- [ ] **Step 4: Commit**

```bash
git add skills/chrome-cdp/scripts/cdp.mjs
git commit -m "feat(perceive): collect table cell style hints in browser-side eval

Scans table cells for background color, font weight, and text color
anomalies using sibling-relative baseline detection. Keyed by
tableIdx:cellText:colIdx for AX tree matching. Data collected but
not yet rendered."
```

---

### Task 2: Consume styleHints in the `visit()` AX tree renderer

**Files:**
- Modify: `skills/chrome-cdp/scripts/cdp.mjs` — the Node-side code in `perceiveStr` after the eval, specifically the `visit()` function and the setup code before it

This task makes the collected styleHints visible in the perceive output by appending them to `[cell]` AX tree lines.

- [ ] **Step 1: Add tableIdxMap and cellInRow tracking**

After the line `const tableRowCounts = new Map();` (which tracks row counts for truncation), add:

```javascript
  const tableIdxMap = new Map(); // tableAncestorId (nodeId) → sequential table index
  let nextTableIdx = 0;
```

- [ ] **Step 2: Assign table index when entering a new table context in `visit()`**

Inside `visit()`, after the existing block that sets `tableAncestorId` for table/grid/treegrid roles (the `if (role === 'table' || role === 'grid' || role === 'treegrid')` block), add table index assignment:

```javascript
    if (role === 'table' || role === 'grid' || role === 'treegrid') {
      tableAncestorId = node.nodeId;
      tableRowCounts.set(tableAncestorId, 0);
      // NEW: assign sequential table index for styleHints matching
      if (!tableIdxMap.has(tableAncestorId)) {
        tableIdxMap.set(tableAncestorId, nextTableIdx++);
      }
    }
```

- [ ] **Step 3: Add cellInRow counter for row tracking, and styleHint lookup for cells**

Inside `visit()`, after the existing row-tracking block (the `if (tableAncestorId && role === 'row')` block), add a cell-in-row counter. Then, in the node rendering section (after `let line = formatAxNode(node, depth);`), add styleHint lookup for cell roles.

Add a `cellInRow` variable to `visit()` parameters — but since `visit()` already has 4 params and is recursive, use a mutable context instead. Right after the `tableIdxMap` declaration, add:

```javascript
  const rowCellIdx = new Map(); // tableAncestorId → current cell index in current row
```

In `visit()`, when we encounter a `row` role (inside the existing row-tracking block, before the `return` for truncated rows), reset the cell counter:

```javascript
    if (tableAncestorId && role === 'row') {
      const count = tableRowCounts.get(tableAncestorId) || 0;
      tableRowCounts.set(tableAncestorId, count + 1);
      rowCellIdx.set(tableAncestorId, 0); // NEW: reset cell index for this row
      if (count >= TABLE_ROW_LIMIT) {
        // ... existing truncation logic unchanged ...
```

Then, in the rendering section, after the existing layout annotation block (after the `if (ENRICHED_ROLES.has(role))` block and before `treeLines.push(line);`), add styleHint consumption for cell nodes:

```javascript
      // Enrich table cells with style hints
      if (tableAncestorId && (role === 'cell' || role === 'gridcell' || role === 'columnheader' || role === 'rowheader')) {
        const ti = tableIdxMap.get(tableAncestorId);
        const ci = rowCellIdx.get(tableAncestorId) || 0;
        rowCellIdx.set(tableAncestorId, ci + 1);
        if (ti != null && meta.styleHints) {
          const cellName = (node.name?.value ?? '').trim().slice(0, 50);
          const hint = meta.styleHints[ti + ':' + cellName + ':' + ci];
          if (hint) line += '  ' + hint;
        }
      }
```

- [ ] **Step 4: Verify with a real styled table**

Open a page with a styled table (e.g., any page with conditional cell coloring, or use eval to add inline styles to cells on any table page):

```bash
# Add test styles to an existing table
node scripts/cdp.mjs eval <target> "
  var cells = document.querySelectorAll('td');
  if (cells[0]) cells[0].style.backgroundColor = 'rgb(255, 200, 200)';
  if (cells[1]) cells[1].style.fontWeight = 'bold';
  'styled ' + cells.length + ' cells'
"

# Run perceive and check for style hints
node scripts/cdp.mjs perceive <target>
```

Expected: `[cell]` lines for the styled cells should show `bg:rgb(255, 200, 200)` and `bold` annotations. Unstyled cells should have no annotations.

- [ ] **Step 5: Verify perceive still works on a page with no tables**

```bash
node scripts/cdp.mjs perceive <target-without-tables>
```

Expected: normal output, no errors, no style hint annotations.

- [ ] **Step 6: Commit**

```bash
git add skills/chrome-cdp/scripts/cdp.mjs
git commit -m "feat(perceive): render style hints on table cell AX nodes

Consume styleHints collected in browser-side eval by matching
tableIdx:cellText:colIdx keys to AX tree cell nodes. Agents can
now see bg colors, bold, and text color anomalies directly in
perceive output without screenshots."
```

---

### Task 3: Update SKILL.md — add verification decision tree and restructure guidance

**Files:**
- Modify: `skills/chrome-cdp/SKILL.md`

This task restructures SKILL.md to be scenario-driven. Three sub-changes: (a) add verification decision tree, (b) consolidate scattered screenshot warnings, (c) update workflow examples.

- [ ] **Step 1: Add "Verifying changes after actions" section**

After the existing "Observation workflow" section (the code block ending with `3. scanshot <target> ...`), add the new section:

```markdown
### Verifying changes after actions

After modifying code or interacting with a page, choose your verification tool based on **what you need to confirm**:

| What to verify | Tool | Why |
|---|---|---|
| Content/structure changed | `perceive` — AX tree shows new/changed nodes | 100% accurate text from DOM |
| CSS styles applied (color, bold, bg) | `perceive` — style hints on table cells show `bg:rgb(...)`, `bold`, `color:rgb(...)` | Reads `getComputedStyle` directly — no pixel interpretation needed |
| Element exists/visible | `perceive` — node presence + `↑above fold`/`↓below fold` | Structured, not pixel guessing |
| Layout/spacing correct | `perceive` — `↕height`, `display`, `gap` on landmarks | Exact px values |
| Visual polish/aesthetics | `elshot <selector>` on the specific component | Only for **subjective** visual quality that can't be expressed as structured data |
| Animation/transition | `elshot <selector>` before and after | Only case truly needing pixel capture |

**Key insight:** `perceive` now includes **style anomaly detection** on table cells. If a cell has a non-default background color, bold text, or unusual text color compared to its column siblings, perceive annotates it directly (e.g., `[cell] 70.0%  bg:rgb(255,200,200)  bold`). You don't need a screenshot to verify conditional styling.
```

- [ ] **Step 2: Simplify the "Observation Strategy" blockquote**

Replace the existing blockquote at the top of the "Observation Strategy" section (lines 21-33 of SKILL.md — the `> **CRITICAL — Read this before any page inspection.**` block) with a shorter, less repetitive version:

```markdown
> **Three-tier perception model:**
>
> | Tier | Command | When to use | Output |
> |------|---------|-------------|--------|
> | 1. **Perceive** | `perceive` | **Default starting point** for any page inspection | AX tree + layout + style hints (~200-400 tokens) |
> | 2. **Targeted visual** | `elshot <selector>` | Verify visual rendering of a **specific element** | Clipped PNG of one element |
> | 3. **Full visual** | `scanshot` | Last resort — pixel-level audit of **entire page** | Multiple viewport-sized PNGs (expensive!) |
>
> Always start with `perceive`. See **"Verifying changes after actions"** below for when to use each tier.
```

- [ ] **Step 3: Update the perceive command documentation**

In the "Perceive page" section (around line 119-145), update the description to mention style hints. After the line about "Enriched AX tree", add a bullet:

```markdown
- **Style anomaly hints**: on table cells, annotates non-default background colors, bold text, and unusual text colors compared to column siblings — e.g., `[cell] 70.0%  bg:rgb(255,200,200)  bold`
```

Update the example output to include a style hint:

```
[table] Department Health  ↕400px
  [row] header
    [columnheader] Department
    [columnheader] Failure Rate
  [row]
    [cell] LLM Technology  bold
    [cell] 33.3%  bg:rgb(255,235,200)
  ... more rows truncated
```

- [ ] **Step 4: Update workflow examples**

Replace the "Understanding a page" workflow with:

```markdown
### Understanding a page (default workflow)
1. `perceive <target>` — structure + layout + console health + style anomalies
2. If needed: `elshot <target> ".specific-element"` — verify visual rendering of a component
3. If needed: `snap <target> --full` — deeper accessibility tree detail
```

Replace the "Comparing pages" workflow with:

```markdown
### Comparing pages or evaluating design quality
1. `perceive` **both** pages — compare structure, layout, style hints (colors, bold, font sizes)
2. `elshot` **specific sections** only if perceive shows identical structure but you need subjective aesthetic comparison
3. Analyze from perceive data: content hierarchy, data density, style anomalies, layout organization
```

Replace the "Debugging a broken page" workflow with:

```markdown
### Debugging a broken page
1. `perceive <target>` — structure + console errors + style anomalies in one call
2. `console <target> --errors` — detailed error messages + stack traces if needed
3. Check perceive style hints for visual issues first; `elshot` only for subjective visual quality
4. `styles <target> ".broken-element"` — full computed styles if needed
```

Replace the "Visual bug investigation" workflow with:

```markdown
### Visual bug investigation
1. `perceive <target>` — structure + layout positions + style hints
2. Check perceive for style anomalies (`bg:`, `bold`, `color:` annotations)
3. `styles <target> ".suspect"` — full computed CSS if perceive hints aren't enough
4. `elshot <target> ".suspect"` — only if you need to see the actual rendered pixels
```

- [ ] **Step 5: Remove the "Why perceive-first is better" section**

The key points from this section are now covered by the decision tree and the three-tier model. Find and remove the `### Why perceive-first is better` heading and its bullet list (6 bullets: "No scroll position errors", "No DPR confusion", "Token-efficient", "Semantically richer", "Spatial awareness", "Reliable for text content"). The information is not lost — it's distributed into the decision tree's "Why" column and the simplified blockquote.

> **Note:** All line numbers in this task refer to the **original** unmodified SKILL.md. Since steps modify content sequentially, always locate sections by their heading text or content, not line numbers.

- [ ] **Step 6: Verify SKILL.md renders correctly**

Read through the modified SKILL.md to ensure:
- No broken markdown tables
- No orphaned references to removed sections
- The flow reads naturally: observation strategy → verification decision tree → commands → workflows

- [ ] **Step 7: Commit**

```bash
git add skills/chrome-cdp/SKILL.md
git commit -m "docs(SKILL.md): scenario-driven verification guidance, document style hints

Replace 6+ scattered screenshot warnings with a single verification
decision tree. Document perceive's new style anomaly hints on table
cells. Update all workflow examples to reflect perceive-first approach
with style hints."
```

---

### Task 4: End-to-end verification

**Files:** None modified — this is a verification-only task.

- [ ] **Step 1: Test perceive on a page with a styled data table**

Find or create a page with conditional cell coloring (e.g., Ant Design table with colored cells). Run perceive and confirm:
- Style hints appear on cells with non-default backgrounds
- Bold cells are annotated
- Header cells are not falsely annotated
- Unstyled cells show no hints

```bash
node scripts/cdp.mjs perceive <target>
```

- [ ] **Step 2: Test perceive on a page with NO tables**

Confirm no errors and no spurious style hints.

- [ ] **Step 3: Test perceive on a page with a large table (>5 rows)**

Confirm `TABLE_ROW_LIMIT` still works — only 5 data rows rendered, and style hints only appear on those 5 rows.

- [ ] **Step 4: Test perceive on a page with a small table (<4 rows)**

Confirm the "small table" path works — all non-default styles are reported directly without baseline comparison.

- [ ] **Step 5: Verify SKILL.md is coherent**

Read through the final SKILL.md and confirm:
- Decision tree is present and well-formatted
- No redundant screenshot warnings remain
- Workflow examples reference style hints
- Example perceive output includes style hints

- [ ] **Step 6: Final commit (if any fixes needed)**

Only commit if verification uncovered issues that needed fixing.
