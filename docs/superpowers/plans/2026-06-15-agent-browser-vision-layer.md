# Agent Browser Vision Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve `chrome-cdp-ex` into an agent-native live browser perception and control layer while preserving its zero-runtime-dependency, single-file CLI distribution advantage.

**Architecture:** Keep `skills/chrome-cdp-ex/scripts/cdp.mjs` as the installable CLI artifact. First introduce registry, schema, session, perception, and action contracts inside the existing file; only after those contracts are covered by tests, split development sources into modules and generate the single-file CLI.

**Tech Stack:** Node.js 22+ ESM, raw Chrome DevTools Protocol, built-in WebSocket, local daemon socket IPC, Vitest, ESLint, Markdown docs, live browser smoke tests with an isolated debug profile.

---

## Product North Star

`chrome-cdp-ex` should become the best "eyes for agents" on real web pages.

It should answer four questions better than generic browser automation:

1. What am I seeing?
2. What matters on this page?
3. What changed after my action?
4. What should I inspect or do next?

Playwright remains the deterministic test runner. `chrome-cdp-ex` becomes the live-page perception and control layer for agents.

## Success Metrics

Use these metrics to decide whether a feature belongs in the product:

- Calls required to understand a page.
- Tokens per useful observation.
- Action success rate without an extra verification call.
- Stale-ref recovery rate.
- Time to identify CSS source.
- Success rate on real logged-in apps.
- Success rate on iframe, modal, HMR, virtualized, and Electron-heavy apps.
- Long-session stability over 20 to 60 minutes.

## Release Strategy

### Release 2.5: Structured Perception Kernel

Product value: agents can parse observations reliably while humans still get compact text.

Deliverables:

- In-file command registry.
- `--format text|json` parsing infrastructure.
- `status --format json`.
- `summary --format json`.
- `console --format json`.
- `perceive --format json`.
- Initial `PerceptionModel`.
- Explicit `SessionState`.
- Docs contract checker.

Exit criteria:

- `npm test` passes.
- `npm run lint` passes.
- `npm run smoke:live` passes when a supported browser is available.
- Default text output remains compatible enough that existing examples still work.
- JSON output has versioned `schema` fields.
- README, SKILL, and CLI usage are checked against the command registry.

### Release 2.6: Action Evidence And Session Reports

Product value: every mutating command gives agents enough evidence to decide the next step.

Deliverables:

- Standard `ActionResult`.
- Feedback policy metadata for every mutating command.
- Feedback for `fill`, `type`, all safe `press` variants, `inject`, `reload`, and `upload`.
- `perceive --since-action`.
- Per-target daemon log file.
- Session screenshot directory.
- `record-actions`.
- `report <session>`.

Exit criteria:

- Every mutating command has a declared feedback policy.
- Action results support text and JSON.
- Report includes action timeline, DOM diffs, console/network deltas, and screenshots where captured.
- Live smoke asserts action evidence for click, fill, press, nav, inject, and reload.

Status note (2026-06-16): ActionResult now captures post-dispatch console, exception, and network deltas from daemon buffers; action text, session reports, session JSONL logs, and record-actions artifacts include compact diagnostic summaries.

### Release 2.7: Modern Web App Coverage

Product value: the tool works reliably on iframe-heavy, component-heavy, authenticated, HMR-heavy web apps.

Deliverables:

- `frames <target>`.
- `perceive <target> --frame <frame-id>`.
- Frame-qualified refs such as `@f2:4`.
- Basic checkpoint/restore for URL, cookies, localStorage, and sessionStorage.
- Replay from recorded action flow.
- `diff-shot` MVP.
- `components` MVP using framework hooks when available.

Exit criteria:

- Live smoke includes iframe fixture, SPA navigation, HMR-like DOM rewrite, modal, table styling, and network failure.
- Replay reproduces a recorded flow in a spawned debug profile.
- Checkpoint/restore docs include security warnings.

## File Structure

### Existing files touched first

- `skills/chrome-cdp-ex/scripts/cdp.mjs`: command registry, format parsing, structured perception, session state, action feedback, and release-compatible CLI behavior.
- `tests/cdp.test.mjs`: pure tests for registry, schemas, perception model, session state, and action result contracts.
- `scripts/live-smoke.mjs`: real-browser coverage for structured output and action evidence.
- `README.md`: product positioning, command docs, JSON contract examples, and roadmap update.
- `skills/chrome-cdp-ex/SKILL.md`: agent-facing workflow contract.
- `TODOS.md`: keep as a release checklist after each task.
- `package.json`: add contract-check and generated-file scripts when those scripts exist.

### New files

- `docs/strategy/agent-browser-vision.md`: product compass, metrics, and Playwright positioning.
- `docs/superpowers/plans/2026-06-15-agent-browser-vision-layer.md`: this plan.
- `scripts/check-docs-contract.mjs`: verifies docs and usage against command registry.
- `scripts/check-generated-cdp.mjs`: after modularization, verifies generated CLI is current.
- `tests/fixtures/perception/simple-form.html`: fixture for forms and refs.
- `tests/fixtures/perception/table-styles.html`: fixture for style anomalies and cascade-friendly output.
- `tests/fixtures/perception/modal.html`: fixture for dialog perception and dismissal.
- `tests/fixtures/perception/repeated-landmarks.html`: fixture for identity-based layout enrichment.
- `tests/fixtures/perception/iframe-host.html`: fixture for frame inventory.
- `tests/fixtures/perception/iframe-child.html`: fixture for same-origin frame perception.

### Later source modules

Create these only after the in-file contracts pass tests:

- `src/cli/main.mjs`
- `src/cli/argv.mjs`
- `src/cli/usage.mjs`
- `src/cdp/client.mjs`
- `src/browser/discovery.mjs`
- `src/browser/spawn-debug-browser.mjs`
- `src/daemon/server.mjs`
- `src/daemon/ipc.mjs`
- `src/daemon/session-state.mjs`
- `src/daemon/observers.mjs`
- `src/perception/perceive.mjs`
- `src/perception/model.mjs`
- `src/perception/format-text.mjs`
- `src/perception/format-json.mjs`
- `src/perception/token-budget.mjs`
- `src/refs/ref-store.mjs`
- `src/refs/target-descriptor.mjs`
- `src/actions/feedback.mjs`
- `src/commands/registry.mjs`
- `src/output/schemas.mjs`
- `scripts/build-cdp.mjs`

## Implementation Tasks

### Task 0: Product Compass And Benchmark Definition

**Files:**
- Create: `docs/strategy/agent-browser-vision.md`
- Modify: `README.md`
- Modify: `TODOS.md`

- [ ] **Step 1: Write the strategy document**

Add `docs/strategy/agent-browser-vision.md` with this structure:

```markdown
# Agent Browser Vision Strategy

## Thesis

Playwright is the deterministic test runner. `chrome-cdp-ex` is the live-page perception and control layer for agents.

## Differentiators

- Real logged-in browser sessions.
- One-call page perception.
- Layout, style, coordinate, console, and ref awareness in compact output.
- CSS source tracing through `cascade`.
- Action feedback that reports effects, not only dispatch success.
- Electron, WSL2, and long-session ergonomics.
- Zero runtime dependencies and single-file distribution.

## Core Workflows

1. Inspect logged-in dashboard.
2. Identify broken UI state.
3. Trace CSS source.
4. Prototype CSS fix with `inject`.
5. Fill form and verify effect.
6. Close modal safely.
7. Debug console/network failure.
8. Record cause/effect after action.
9. Export deterministic Playwright test from observed flow.

## Metrics

- Calls to understand page.
- Tokens per useful observation.
- Action success with no extra verification call.
- Stale-ref recovery rate.
- Time to identify CSS source.
- Success rate on real logged-in apps.
- Success rate on iframe/modal/HMR-heavy apps.
```

- [ ] **Step 2: Link the strategy from README**

Add a short "Product direction" paragraph near the README introduction:

```markdown
## Product direction

`chrome-cdp-ex` is designed as a live-page perception and control layer for agents. Playwright is still the right tool for deterministic isolated tests; this project focuses on real browser sessions, low-token perception, layout/style awareness, CSS source tracing, and action feedback. See `docs/strategy/agent-browser-vision.md` for the product compass.
```

- [ ] **Step 3: Update release checklist**

Add a `Release 2.5` section in `TODOS.md` with checked boxes left unchecked for the deliverables in this plan.

- [ ] **Step 4: Verify docs render**

Run:

```bash
rtk sed -n '1,220p' docs/strategy/agent-browser-vision.md
rtk sed -n '1,80p' README.md
```

Expected: both files show the product direction without broken Markdown headings.

- [ ] **Step 5: Commit**

```bash
rtk git add docs/strategy/agent-browser-vision.md README.md TODOS.md
rtk git commit -m "docs: define agent browser vision strategy"
```

### Task 1: Add In-File Command Registry

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/cdp.test.mjs`

- [ ] **Step 1: Write failing registry tests**

Add tests to `tests/cdp.test.mjs`:

```js
describe('COMMANDS registry', () => {
  it('exports command metadata with unique names', () => {
    const names = T.COMMANDS.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('generates target command requirements from registry metadata', () => {
    const fromRegistry = new Set(
      T.COMMANDS
        .filter(c => c.needsTarget)
        .flatMap(c => [c.name, ...(c.aliases || [])])
    );
    expect(fromRegistry).toEqual(T.NEEDS_TARGET);
  });

  it('marks mutating commands with a feedback policy or explicit none policy', () => {
    const mutating = T.COMMANDS.filter(c => c.mutates);
    expect(mutating.map(c => c.name).sort()).toEqual([
      'back', 'click', 'clickxy', 'closetab', 'cookiedel', 'cookieset',
      'dismiss-modal', 'fill', 'forward', 'inject', 'jsclick', 'nav',
      'open', 'press', 'reload', 'scroll', 'select', 'spawn-debug-browser',
      'stop', 'type', 'upload', 'viewport',
    ].sort());
    for (const command of mutating) {
      expect(command.feedbackPolicy).toMatch(/^(none|settle-diff|full-perceive|state-change|report-only)$/);
    }
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npm test -- tests/cdp.test.mjs -t "COMMANDS registry"
```

Expected: fails because `T.COMMANDS` and `T.NEEDS_TARGET` are not exported together.

- [ ] **Step 3: Add registry metadata in `cdp.mjs`**

Add near the existing `USAGE` and `NEEDS_TARGET` definitions:

```js
const COMMANDS = Object.freeze([
  { name: 'list', aliases: [], needsTarget: false, mutates: false, outputFormats: ['text'] },
  { name: 'open', aliases: [], needsTarget: false, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text'] },
  { name: 'doctor', aliases: ['ready'], needsTarget: false, mutates: false, outputFormats: ['text'] },
  { name: 'spawn-debug-browser', aliases: ['spawn'], needsTarget: false, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'stop', aliases: [], needsTarget: false, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'perceive', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'snap', aliases: ['snapshot'], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'eval', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'eval64', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'call', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'wait', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'keepalive', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'shot', aliases: ['screenshot'], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'html', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'nav', aliases: ['navigate'], needsTarget: true, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text', 'json'] },
  { name: 'net', aliases: ['network'], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'status', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'console', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'summary', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'elshot', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'click', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'jsclick', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'clickxy', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'type', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'press', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'scroll', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'hover', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'waitfor', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'loadall', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'fill', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'select', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'fullshot', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'scanshot', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'styles', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'cookies', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'cookieset', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'cookiedel', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'evalraw', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'batch', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'dialog', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'viewport', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'upload', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'state-change', outputFormats: ['text', 'json'] },
  { name: 'text', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'table', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'back', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text', 'json'] },
  { name: 'forward', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text', 'json'] },
  { name: 'reload', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text', 'json'] },
  { name: 'closetab', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'netlog', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'inject', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'state-change', outputFormats: ['text', 'json'] },
  { name: 'cascade', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'record', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'flow', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'repeat', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'dismiss-modal', aliases: ['dismissmodal'], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
]);

const NEEDS_TARGET = new Set(
  COMMANDS
    .filter(command => command.needsTarget)
    .flatMap(command => [command.name, ...command.aliases])
);
```

- [ ] **Step 4: Export registry for tests**

Add `COMMANDS` and `NEEDS_TARGET` to the `__test__` export.

- [ ] **Step 5: Run registry tests**

Run:

```bash
npm test -- tests/cdp.test.mjs -t "COMMANDS registry"
```

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm test
npm run lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs
rtk git commit -m "refactor: add command registry metadata"
```

### Task 2: Add Output Format Infrastructure

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/cdp.test.mjs`
- Modify: `README.md`
- Modify: `skills/chrome-cdp-ex/SKILL.md`

- [ ] **Step 1: Write failing format parser tests**

Add tests:

```js
describe('parseFormatArgs', () => {
  it('defaults to text format', () => {
    expect(T.parseFormatArgs(['--runtime'])).toEqual({
      format: 'text',
      args: ['--runtime'],
    });
  });

  it('parses --format json and removes the option from command args', () => {
    expect(T.parseFormatArgs(['--runtime', '--format', 'json'])).toEqual({
      format: 'json',
      args: ['--runtime'],
    });
  });

  it('rejects unknown formats', () => {
    expect(() => T.parseFormatArgs(['--format', 'xml'])).toThrow(/format must be text or json/);
  });
});
```

- [ ] **Step 2: Implement parser**

Add:

```js
function parseFormatArgs(args, allowed = ['text']) {
  const next = [];
  let format = 'text';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format') {
      const value = args[++i];
      if (!allowed.includes(value)) {
        throw new Error(`format must be ${allowed.join(' or ')}`);
      }
      format = value;
    } else {
      next.push(args[i]);
    }
  }
  return { format, args: next };
}

function formatJson(model) {
  return JSON.stringify(model, null, 2);
}
```

- [ ] **Step 3: Add JSON models for low-risk commands**

Add model builders:

```js
function buildConsoleModel(consoleBuf, exceptionBuf, lastReadSeq, flag) {
  return {
    schema: 'chrome-cdp-ex.console.v1',
    mode: flag || 'new',
    entries: consoleBuf.since(flag === '--all' ? 0 : lastReadSeq.console),
    exceptions: exceptionBuf.since(flag === '--all' ? 0 : lastReadSeq.exception),
  };
}

function buildStatusModel({ targetId, consoleBuf, exceptionBuf, navBuf, lastReadSeq }) {
  return {
    schema: 'chrome-cdp-ex.status.v1',
    targetId,
    console: consoleBuf.since(lastReadSeq.console),
    exceptions: exceptionBuf.since(lastReadSeq.exception),
    navigation: navBuf.since(lastReadSeq.nav),
  };
}
```

Keep existing text functions as default.

- [ ] **Step 4: Wire `console`, `status`, and `summary` through parser**

For each command, parse allowed formats:

```js
const fopts = parseFormatArgs(args, ['text', 'json']);
if (fopts.format === 'json') result = formatJson(buildConsoleModel(consoleBuf, exceptionBuf, lastReadSeq, fopts.args[0]));
else result = await consoleStr(consoleBuf, exceptionBuf, lastReadSeq, fopts.args[0]);
```

- [ ] **Step 5: Export parser for tests**

Add `parseFormatArgs` and `formatJson` to `__test__`.

- [ ] **Step 6: Add docs examples**

Add examples:

```markdown
cdp status <target> --format json
cdp summary <target> --format json
cdp console <target> --format json
```

- [ ] **Step 7: Verify**

Run:

```bash
npm test -- tests/cdp.test.mjs -t "parseFormatArgs"
npm test
npm run lint
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs README.md skills/chrome-cdp-ex/SKILL.md
rtk git commit -m "feat: add structured output format support"
```

### Task 3: Promote `perceive` To A Structured Perception Model

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/cdp.test.mjs`
- Modify: `scripts/live-smoke.mjs`
- Modify: `README.md`
- Modify: `skills/chrome-cdp-ex/SKILL.md`

- [ ] **Step 1: Write failing model tests**

Add tests:

```js
describe('PerceptionModel', () => {
  it('builds a versioned model with page, viewport, console, refs, and nodes', () => {
    const model = T.createPerceptionModel({
      page: { title: 'Example', url: 'https://example.com' },
      viewport: { width: 1280, height: 720, scrollY: 0, scrollMax: 1000 },
      consoleHealth: { errors: 1, warnings: 2, exceptions: 0 },
      refs: { generation: 3 },
      nodes: [{ ref: '@1', role: 'button', name: 'Submit', rect: { x: 10, y: 20, width: 80, height: 30 } }],
      limits: { truncated: false },
    });

    expect(model.schema).toBe('chrome-cdp-ex.perceive.v1');
    expect(model.viewport.coordinateSpace).toBe('viewport-css-px');
    expect(model.nodes[0].ref).toBe('@1');
  });

  it('formats perception JSON as parseable output', () => {
    const model = T.createPerceptionModel({
      page: { title: 'Example', url: 'https://example.com' },
      viewport: { width: 1280, height: 720, scrollY: 0, scrollMax: 1000 },
      consoleHealth: { errors: 0, warnings: 0, exceptions: 0 },
      refs: { generation: 1 },
      nodes: [],
      limits: { truncated: false },
    });
    expect(JSON.parse(T.formatPerceptionJson(model)).schema).toBe('chrome-cdp-ex.perceive.v1');
  });
});
```

- [ ] **Step 2: Add model helpers**

Add:

```js
function createPerceptionModel({ page, viewport, consoleHealth, refs, nodes, limits }) {
  return {
    schema: 'chrome-cdp-ex.perceive.v1',
    page,
    viewport: {
      ...viewport,
      coordinateSpace: 'viewport-css-px',
    },
    console: consoleHealth,
    refs: {
      generation: refs.generation,
      validity: 'until-navigation-or-dom-rewrite',
    },
    nodes,
    limits,
  };
}

function formatPerceptionJson(model) {
  return JSON.stringify(model, null, 2);
}
```

- [ ] **Step 3: Refactor `perceiveStr` internally**

Keep `perceiveStr` as the public command helper. Internally split it into:

```js
async function perceiveModel(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts, refState) {
  const text = await perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, { ...opts, format: 'text' }, refState);
  return createPerceptionModel({
    page: opts.page || { title: '', url: '' },
    viewport: opts.viewport || { width: 0, height: 0, scrollY: 0, scrollMax: 0 },
    consoleHealth: opts.consoleHealth || { errors: 0, warnings: 0, exceptions: 0 },
    refs: { generation: refState.generation || 0 },
    nodes: [],
    limits: { truncated: text.includes('truncated') },
  });
}
```

Then replace the placeholder page, viewport, console, and node values with real values already computed by the existing perceive pipeline. Preserve the current text output path while model fields are filled.

- [ ] **Step 4: Add `perceive --format json`**

In the daemon switch:

```js
case 'perceive': {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const popts = parsePerceiveArgs(fopts.args);
  if (fopts.format === 'json') {
    const model = await perceiveModel(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState);
    result = formatPerceptionJson(model);
  } else {
    result = await perceiveStr(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState);
  }
  break;
}
```

- [ ] **Step 5: Add live smoke assertion**

In `scripts/live-smoke.mjs`, after a successful text `perceive`, run:

```js
const perceiveJson = await cdp(target, ['perceive', '--format', 'json']);
const parsed = JSON.parse(perceiveJson);
assert.equal(parsed.schema, 'chrome-cdp-ex.perceive.v1');
assert.equal(parsed.viewport.coordinateSpace, 'viewport-css-px');
```

- [ ] **Step 6: Verify**

Run:

```bash
npm test -- tests/cdp.test.mjs -t "PerceptionModel"
npm test
npm run lint
npm run smoke:live
```

Expected: unit and lint pass; smoke passes when a supported browser is available, or reports a documented browser availability skip.

- [ ] **Step 7: Commit**

```bash
rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs scripts/live-smoke.mjs README.md skills/chrome-cdp-ex/SKILL.md
rtk git commit -m "feat: add structured perception output"
```

### Task 4: Introduce Explicit `SessionState`

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/cdp.test.mjs`

- [ ] **Step 1: Write failing session tests**

Add:

```js
describe('SessionState', () => {
  it('creates explicit daemon session state', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    expect(state.targetId).toBe('ABC123');
    expect(state.sessionId).toBe('sid-1');
    expect(state.refs.map).toBeInstanceOf(Map);
    expect(state.refs.invalidationReason).toBe('daemon-start');
  });

  it('invalidates refs on navigation', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    state.refs.map.set(1, 42);
    T.invalidateSessionRefs(state, 'navigation');
    expect(state.refs.map.size).toBe(0);
    expect(state.refs.invalidationReason).toBe('navigation');
  });
});
```

- [ ] **Step 2: Add session helpers**

Add:

```js
function createSessionState({ targetId, sessionId }) {
  return {
    targetId,
    sessionId,
    pageGeneration: 0,
    refGeneration: 0,
    refs: {
      map: new Map(),
      invalidationReason: 'daemon-start',
      lastPerceiveAt: 0,
    },
    lastPerceive: { output: null, model: null },
    lastAction: null,
    buffers: {},
    pendingRequests: new Map(),
    screenshots: [],
    records: [],
    frames: [],
    injections: [],
    privacy: {
      redactCookies: true,
      redactStorage: true,
      redactAuthorizationHeaders: true,
    },
  };
}

function invalidateSessionRefs(session, reason) {
  session.refs.map.clear();
  session.refs.invalidationReason = reason;
  session.refGeneration += 1;
}
```

- [ ] **Step 3: Replace closure variables gradually**

Inside `runDaemon(targetId)`, create:

```js
const session = createSessionState({ targetId, sessionId });
session.buffers = {
  console: consoleBuf,
  exception: exceptionBuf,
  navigation: navBuf,
  network: netReqBuf,
  dialog: dialogBuf,
};
session.pendingRequests = pendingReqs;
```

Keep existing variable names temporarily by aliasing:

```js
const refMap = session.refs.map;
const lastPerceiveStore = session.lastPerceive;
const refState = session.refs;
```

- [ ] **Step 4: Route navigation invalidation through helper**

Replace direct ref clearing in navigation event handlers with:

```js
invalidateSessionRefs(session, 'navigation');
```

- [ ] **Step 5: Export helpers**

Add `createSessionState` and `invalidateSessionRefs` to `__test__`.

- [ ] **Step 6: Verify**

Run:

```bash
npm test -- tests/cdp.test.mjs -t "SessionState"
npm test
npm run lint
npm run smoke:live
```

Expected: PASS or documented smoke skip.

- [ ] **Step 7: Commit**

```bash
rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs
rtk git commit -m "refactor: make daemon session state explicit"
```

### Task 5: Standardize `ActionResult`

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/cdp.test.mjs`
- Modify: `scripts/live-smoke.mjs`
- Modify: `README.md`
- Modify: `skills/chrome-cdp-ex/SKILL.md`

- [ ] **Step 1: Write failing action result tests**

Add:

```js
describe('ActionResult', () => {
  it('creates versioned action evidence', () => {
    const result = T.createActionResult({
      action: 'click',
      target: { input: '@4', resolvedBy: 'ref', label: 'Submit' },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 120 },
      effects: { domDiff: 'button disabled', console: [], network: [], navigation: null },
      nextHint: 'Use perceive --diff if more evidence is needed',
    });
    expect(result.schema).toBe('chrome-cdp-ex.action.v1');
    expect(result.action).toBe('click');
    expect(result.dispatch.ok).toBe(true);
  });

  it('formats action evidence as compact text', () => {
    const text = T.formatActionText(T.createActionResult({
      action: 'fill',
      target: { input: '#email', resolvedBy: 'selector', label: 'Email' },
      dispatch: { ok: true, method: 'Input.insertText' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: 'value changed', console: [], network: [], navigation: null },
      nextHint: 'Continue with the next form field',
    }));
    expect(text).toMatch(/fill/i);
    expect(text).toMatch(/value changed/);
  });
});
```

- [ ] **Step 2: Add action helpers**

Add:

```js
function createActionResult({ action, target, dispatch, settle, effects, nextHint }) {
  return {
    schema: 'chrome-cdp-ex.action.v1',
    action,
    target,
    dispatch,
    settle,
    effects,
    nextHint,
  };
}

function formatActionText(result) {
  const lines = [
    `${result.action}: ${result.dispatch.ok ? 'dispatched' : 'failed'} via ${result.dispatch.method}`,
  ];
  if (result.target?.label) lines.push(`Target: ${result.target.label}`);
  if (result.settle) lines.push(`Settle: ${result.settle.ok ? 'ok' : 'not confirmed'}${result.settle.durationMs ? ` in ${result.settle.durationMs}ms` : ''}`);
  if (result.effects?.domDiff) lines.push('---', result.effects.domDiff);
  if (result.nextHint) lines.push(`Hint: ${result.nextHint}`);
  return lines.join('\n');
}
```

- [ ] **Step 3: Replace `actionFeedback` with policy-driven wrapper**

Add:

```js
async function runActionWithFeedback({ action, dispatch, feedbackPolicy, observe }) {
  const startedAt = Date.now();
  const dispatchText = await dispatch();
  if (feedbackPolicy === 'none' || feedbackPolicy === 'report-only') return dispatchText;
  try {
    const domDiff = await observe();
    const result = createActionResult({
      action,
      target: { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: action },
      settle: { ok: true, durationMs: Date.now() - startedAt },
      effects: { domDiff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --diff if more evidence is needed',
    });
    return `${dispatchText}\n---\n${formatActionText(result)}`;
  } catch (e) {
    if (!isTimeoutError(e)) throw e;
    return `${dispatchText}\n---\n(success but observation timed out after action dispatch: ${e.message}. The action was already sent; run \`perceive --diff\` or \`status\` to refresh.)`;
  }
}
```

- [ ] **Step 4: Apply wrapper to mutating commands**

Use `runActionWithFeedback` for:

- `click`
- `jsclick`
- `clickxy`
- `fill`
- `type`
- `press`
- `select`
- `scroll`
- `nav`
- `back`
- `forward`
- `reload`
- `viewport`
- `inject`
- `dismiss-modal`

- [ ] **Step 5: Add live smoke assertions**

Add checks that `fill`, `press c`, and `inject --css` return action evidence or an explicit report line.

- [ ] **Step 6: Verify**

Run:

```bash
npm test -- tests/cdp.test.mjs -t "ActionResult"
npm test
npm run lint
npm run smoke:live
```

Expected: PASS or documented smoke skip.

- [ ] **Step 7: Commit**

```bash
rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs scripts/live-smoke.mjs README.md skills/chrome-cdp-ex/SKILL.md
rtk git commit -m "feat: standardize action evidence"
```

### Task 6: Add Docs Contract Checker

**Files:**
- Create: `scripts/check-docs-contract.mjs`
- Modify: `package.json`
- Modify: `tests/cdp.test.mjs`
- Modify: `README.md`
- Modify: `skills/chrome-cdp-ex/SKILL.md`

- [ ] **Step 1: Create checker script**

Create `scripts/check-docs-contract.mjs`:

```js
#!/usr/bin/env node
import { readFileSync } from 'fs';

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const read = path => readFileSync(path, 'utf8');
const docs = {
  readme: read('README.md'),
  skill: read('skills/chrome-cdp-ex/SKILL.md'),
};

let failures = 0;

for (const command of T.COMMANDS) {
  const names = [command.name, ...(command.aliases || [])];
  const appears = names.some(name => docs.readme.includes(name)) && names.some(name => docs.skill.includes(name));
  if (!appears) {
    console.error(`Missing command docs for ${command.name}`);
    failures += 1;
  }
}

if (!docs.readme.includes('Playwright is') || !docs.readme.includes('live-page perception')) {
  console.error('README is missing product positioning language');
  failures += 1;
}

if (failures > 0) process.exit(1);
console.log(`Docs contract OK: ${T.COMMANDS.length} commands checked`);
```

- [ ] **Step 2: Add package script**

In `package.json`, add:

```json
"check:docs": "node scripts/check-docs-contract.mjs"
```

- [ ] **Step 3: Run checker and fix missing docs**

Run:

```bash
npm run check:docs
```

Expected after docs fixes: `Docs contract OK: ... commands checked`.

- [ ] **Step 4: Add verification to README contributor section**

Document:

```markdown
npm test
npm run lint
npm run check:docs
npm run smoke:live
```

- [ ] **Step 5: Verify all**

Run:

```bash
npm test
npm run lint
npm run check:docs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add scripts/check-docs-contract.mjs package.json README.md skills/chrome-cdp-ex/SKILL.md tests/cdp.test.mjs
rtk git commit -m "test: add docs contract checker"
```

### Task 7: Add Token Budget Scoring For `perceive`

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/cdp.test.mjs`
- Create: `tests/fixtures/perception/repeated-landmarks.html`
- Modify: `README.md`
- Modify: `skills/chrome-cdp-ex/SKILL.md`

- [ ] **Step 1: Write failing token budget tests**

Add:

```js
describe('scorePerceptionNode', () => {
  it('prioritizes focused, visible, interactive, changed, and error-adjacent nodes', () => {
    expect(T.scorePerceptionNode({ focused: true })).toBeGreaterThan(T.scorePerceptionNode({ role: 'paragraph' }));
    expect(T.scorePerceptionNode({ interactive: true, visible: true })).toBeGreaterThan(T.scorePerceptionNode({ interactive: true, visible: false }));
    expect(T.scorePerceptionNode({ changedSinceAction: true })).toBeGreaterThan(T.scorePerceptionNode({ role: 'generic' }));
    expect(T.scorePerceptionNode({ hasConsoleError: true })).toBeGreaterThan(T.scorePerceptionNode({ role: 'paragraph' }));
  });
});
```

- [ ] **Step 2: Add parser support**

Extend `parsePerceiveArgs`:

```js
if (a === '--budget') {
  opts.budget = parseDelayMs(args[++i], { name: 'perception token budget', min: 100, max: 5000 });
}
```

- [ ] **Step 3: Add node scoring**

Add:

```js
function scorePerceptionNode(node) {
  let score = 0;
  if (node.focused) score += 1000;
  if (node.visible) score += 400;
  if (node.interactive || node.ref) score += 300;
  if (node.changedSinceAction) score += 250;
  if (node.hasConsoleError || node.hasWarning) score += 250;
  if (['heading', 'main', 'navigation', 'banner', 'contentinfo', 'form', 'table'].includes(node.role)) score += 120;
  if (node.recent) score += 80;
  if (node.belowFold) score -= 50;
  return score;
}
```

- [ ] **Step 4: Apply budget before text formatting**

When `opts.budget` is set, sort candidate static nodes by score while preserving ancestor context and all visible interactive refs.

- [ ] **Step 5: Document examples**

Add:

```markdown
cdp perceive <target> --budget 800
cdp perceive <target> --budget 1200 --format json
```

- [ ] **Step 6: Verify**

Run:

```bash
npm test -- tests/cdp.test.mjs -t "scorePerceptionNode"
npm test
npm run lint
npm run smoke:live
```

Expected: PASS or documented smoke skip.

- [ ] **Step 7: Commit**

```bash
rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs tests/fixtures/perception/repeated-landmarks.html README.md skills/chrome-cdp-ex/SKILL.md
rtk git commit -m "feat: add perception token budget scoring"
```

### Task 8: Add Frame Inventory MVP

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/cdp.test.mjs`
- Create: `tests/fixtures/perception/iframe-host.html`
- Create: `tests/fixtures/perception/iframe-child.html`
- Modify: `scripts/live-smoke.mjs`
- Modify: `README.md`
- Modify: `skills/chrome-cdp-ex/SKILL.md`

- [ ] **Step 1: Add registry entry**

Add:

```js
{ name: 'frames', aliases: ['frame'], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] }
```

- [ ] **Step 2: Write failing frame formatting tests**

Add:

```js
describe('formatFrames', () => {
  it('formats main and child frames with stable prefixes', () => {
    const frames = [
      { id: 'MAINFRAME123', parentId: null, url: 'https://example.com', securityOrigin: 'https://example.com' },
      { id: 'CHILDFRAME456', parentId: 'MAINFRAME123', url: 'https://example.com/child', securityOrigin: 'https://example.com' },
    ];
    const text = T.formatFrames(frames);
    expect(text).toMatch(/MAINFRAM/);
    expect(text).toMatch(/CHILDFR/);
    expect(text).toMatch(/child/);
  });
});
```

- [ ] **Step 3: Implement frame collection**

Add:

```js
async function framesStr(cdp, sid, args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, sid);
  const frames = flattenFrameTree(frameTree);
  if (fopts.format === 'json') return formatJson({ schema: 'chrome-cdp-ex.frames.v1', frames });
  return formatFrames(frames);
}

function flattenFrameTree(frameTree) {
  const out = [];
  const walk = node => {
    out.push(node.frame);
    for (const child of node.childFrames || []) walk(child);
  };
  walk(frameTree);
  return out;
}

function formatFrames(frames) {
  return frames.map(frame => {
    const prefix = frame.id.slice(0, 8);
    const parent = frame.parentId ? ` parent:${frame.parentId.slice(0, 8)}` : ' main';
    return `${prefix}${parent} ${frame.securityOrigin || 'opaque'} ${frame.url || ''}`;
  }).join('\n');
}
```

- [ ] **Step 4: Wire command**

Add daemon switch case:

```js
case 'frames': case 'frame': result = await framesStr(cdp, sessionId, args); break;
```

- [ ] **Step 5: Add smoke fixture coverage**

Update `scripts/smoke-page.html` or create iframe fixtures and have smoke run:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs frames <target>
node skills/chrome-cdp-ex/scripts/cdp.mjs frames <target> --format json
```

- [ ] **Step 6: Verify**

Run:

```bash
npm test -- tests/cdp.test.mjs -t "formatFrames"
npm test
npm run lint
npm run smoke:live
```

Expected: PASS or documented smoke skip.

- [ ] **Step 7: Commit**

```bash
rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs tests/fixtures/perception/iframe-host.html tests/fixtures/perception/iframe-child.html scripts/live-smoke.mjs README.md skills/chrome-cdp-ex/SKILL.md
rtk git commit -m "feat: add frame inventory command"
```

### Task 9: Add Session Report Skeleton

**Files:**
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`
- Modify: `tests/cdp.test.mjs`
- Modify: `README.md`
- Modify: `skills/chrome-cdp-ex/SKILL.md`

- [ ] **Step 1: Add report model tests**

Add:

```js
describe('SessionReport', () => {
  it('builds a versioned report from session state', () => {
    const session = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    session.lastAction = { action: 'click', ts: 100 };
    const report = T.createSessionReport(session);
    expect(report.schema).toBe('chrome-cdp-ex.report.v1');
    expect(report.targetId).toBe('ABC123');
    expect(report.actions).toEqual([{ action: 'click', ts: 100 }]);
  });
});
```

- [ ] **Step 2: Add report helper**

Add:

```js
function createSessionReport(session) {
  return {
    schema: 'chrome-cdp-ex.report.v1',
    targetId: session.targetId,
    pageGeneration: session.pageGeneration,
    refGeneration: session.refGeneration,
    actions: session.lastAction ? [session.lastAction] : [],
    screenshots: session.screenshots,
    records: session.records,
    frames: session.frames,
  };
}
```

- [ ] **Step 3: Add command registry**

Add:

```js
{ name: 'report', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] }
```

- [ ] **Step 4: Add daemon command**

Add:

```js
case 'report': {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const report = createSessionReport(session);
  result = fopts.format === 'json'
    ? formatJson(report)
    : `Session report for ${report.targetId}\nActions: ${report.actions.length}\nScreenshots: ${report.screenshots.length}\nRecords: ${report.records.length}`;
  break;
}
```

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- tests/cdp.test.mjs -t "SessionReport"
npm test
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add skills/chrome-cdp-ex/scripts/cdp.mjs tests/cdp.test.mjs README.md skills/chrome-cdp-ex/SKILL.md
rtk git commit -m "feat: add session report skeleton"
```

### Task 10: Modularize Development Sources While Keeping Single-File Distribution

**Files:**
- Create: `src/commands/registry.mjs`
- Create: `src/output/schemas.mjs`
- Create: `src/daemon/session-state.mjs`
- Create: `scripts/build-cdp.mjs`
- Create: `scripts/check-generated-cdp.mjs`
- Modify: `package.json`
- Modify: `tests/cdp.test.mjs`
- Modify: `skills/chrome-cdp-ex/scripts/cdp.mjs`

- [ ] **Step 1: Add generated-file check script**

Create `scripts/check-generated-cdp.mjs`:

```js
#!/usr/bin/env node
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';

const before = readFileSync('skills/chrome-cdp-ex/scripts/cdp.mjs', 'utf8');
const result = spawnSync(process.execPath, ['scripts/build-cdp.mjs'], { encoding: 'utf8' });
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status);
}
const after = readFileSync('skills/chrome-cdp-ex/scripts/cdp.mjs', 'utf8');
if (before !== after) {
  console.error('Generated cdp.mjs is not current. Run node scripts/build-cdp.mjs and commit the result.');
  process.exit(1);
}
console.log('Generated cdp.mjs is current');
```

- [ ] **Step 2: Add a conservative build script**

Create `scripts/build-cdp.mjs` that initially preserves current behavior:

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';

const current = readFileSync('skills/chrome-cdp-ex/scripts/cdp.mjs', 'utf8');
writeFileSync('skills/chrome-cdp-ex/scripts/cdp.mjs', current);
console.log('cdp.mjs unchanged');
```

- [ ] **Step 3: Move only registry first**

Create `src/commands/registry.mjs` with `COMMANDS` metadata copied from Task 1. Import it from `cdp.mjs` during development only after the build script can inline it.

- [ ] **Step 4: Update build script to inline modules**

Use a small local bundling approach based on string composition and static imports. Do not add runtime dependencies.

- [ ] **Step 5: Add package scripts**

Add:

```json
"build:cdp": "node scripts/build-cdp.mjs",
"check:generated": "node scripts/check-generated-cdp.mjs"
```

- [ ] **Step 6: Verify**

Run:

```bash
npm run build:cdp
npm run check:generated
npm test
npm run lint
npm run smoke:live
```

Expected: generated CLI is current; tests and lint pass; smoke passes or reports documented browser availability skip.

- [ ] **Step 7: Commit**

```bash
rtk git add src scripts package.json tests/cdp.test.mjs skills/chrome-cdp-ex/scripts/cdp.mjs
rtk git commit -m "build: prepare generated single-file CLI"
```

### Task 11: Add Competitive Benchmark Harness

**Files:**
- Create: `scripts/benchmark-agent-eye.mjs`
- Create: `tests/fixtures/perception/simple-form.html`
- Create: `tests/fixtures/perception/table-styles.html`
- Create: `tests/fixtures/perception/modal.html`
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Create benchmark script**

Create `scripts/benchmark-agent-eye.mjs`:

```js
#!/usr/bin/env node
import { spawnSync } from 'child_process';

const tasks = [
  { name: 'understand simple form', command: ['perceive'] },
  { name: 'trace styled table', command: ['perceive'] },
  { name: 'dismiss modal', command: ['dismiss-modal'] },
  { name: 'status after action', command: ['status'] },
];

const result = {
  schema: 'chrome-cdp-ex.benchmark.v1',
  tasks: tasks.map(task => ({
    name: task.name,
    command: task.command.join(' '),
    metrics: {
      calls: 1,
      tokensEstimated: null,
      success: null,
    },
  })),
};

console.log(JSON.stringify(result, null, 2));
```

- [ ] **Step 2: Add package script**

Add:

```json
"benchmark:agent-eye": "node scripts/benchmark-agent-eye.mjs"
```

- [ ] **Step 3: Document benchmark meaning**

Add README section:

```markdown
## Agent-eye benchmark

The benchmark tracks calls required to understand a page, estimated output tokens, action feedback coverage, stale-ref recovery, CSS-source tracing time, and success on modal, iframe, HMR, and authenticated-session workflows.
```

- [ ] **Step 4: Verify script output**

Run:

```bash
npm run benchmark:agent-eye
```

Expected: JSON with schema `chrome-cdp-ex.benchmark.v1`.

- [ ] **Step 5: Commit**

```bash
rtk git add scripts/benchmark-agent-eye.mjs tests/fixtures/perception package.json README.md
rtk git commit -m "test: add agent-eye benchmark harness"
```

## Verification Gate For Each Release

Before publishing any release from this plan, run:

```bash
npm test
npm run lint
npm run check:docs
npm run check:generated
npm run smoke:live
```

Expected:

- Unit tests pass.
- Lint passes.
- Docs contract passes.
- Generated CLI check passes after modularization exists.
- Live smoke passes when a supported browser is available, or exits with a clear documented skip reason.

## Rollback Strategy

Each task is independently committable. If a task regresses live browser behavior:

1. Keep preceding commits.
2. Revert only the failing task commit.
3. Add a failing regression test that captures the discovered behavior.
4. Re-implement the smallest fix against that test.

## Self-Review

Spec coverage:

- Product positioning is covered by Task 0.
- Command registry is covered by Task 1.
- Structured output is covered by Task 2.
- Perception kernel is covered by Task 3.
- Session state is covered by Task 4.
- Action evidence is covered by Task 5.
- Docs-as-contract is covered by Task 6.
- Token control is covered by Task 7.
- Frame inventory is covered by Task 8.
- Session reports are covered by Task 9.
- Generated single-file distribution is covered by Task 10.
- Competitive benchmarks are covered by Task 11.

Placeholder scan:

- The plan avoids undefined placeholder sections.
- Code snippets define the functions and fields they reference.
- Verification commands include expected outcomes.

Type consistency:

- Schema names use `chrome-cdp-ex.<surface>.v1`.
- Registry fields are `name`, `aliases`, `needsTarget`, `mutates`, `feedbackPolicy`, and `outputFormats`.
- Perception fields are `schema`, `page`, `viewport`, `console`, `refs`, `nodes`, and `limits`.
- Action fields are `schema`, `action`, `target`, `dispatch`, `settle`, `effects`, and `nextHint`.
