# Design: Next Features for chrome-cdp-ex

> Three dimensions of enhancement, released gradually.
> Each feature addresses a **genuine capability gap** that `eval` or
> existing commands cannot solve.

---

## Three Dimensions

| Dimension | Goal | Features |
|-----------|------|----------|
| **Operational** — 更有效率 | Do things faster, access locked capabilities | `inject`, `emulate`, `frame` |
| **Cognitive** — 更正確理解 | Understand WHY the page looks/behaves this way | `cascade`, `components` |
| **Temporal** — 連續情境 | Understand WHAT HAPPENED over time, not just now | `record` |

## Release Plan

| Version | Features | Category |
|---------|----------|----------|
| v2.2.0 | `inject` + `cascade` | Operational + Cognitive |
| v2.3.0 | `emulate` + `record` | Operational + Temporal |
| v2.4.0 | `frame` + `components` | Operational + Cognitive |

---

# v2.2.0 — Inject + Cascade

## `inject` — Live CSS/JS Injection (Operational)

### Problem

Agents doing frontend development constantly inject CSS or load external
scripts. Today this requires 5+ lines of boilerplate eval every time:

```bash
# Current: repetitive boilerplate
cdp eval <target> "(() => { const s = document.createElement('style'); s.textContent = 'body { background: red }'; document.head.appendChild(s); return 'ok'; })()"
```

### Why eval isn't enough

- CSS injection requires `createElement`+`textContent`+`appendChild`
  boilerplate regenerated each time
- JS file injection needs `<script src>` with `onload` wait — non-trivial
  in one-shot eval
- No way to track and remove previously injected elements across calls

### Design

```
inject <target> --css "<css-text>"           # inject inline <style>
inject <target> --css-file <url>             # inject <link rel="stylesheet">
inject <target> --js-file <url>              # inject <script src> + wait for load
inject <target> --remove [id]               # remove injected element(s)
```

Each injection gets `data-cdp-inject="inject-N"` for tracking. The ID
is returned and can be used for targeted removal.

### Implementation

```javascript
async function injectStr(cdp, sid, args) {
  const type = args[0];  // --css, --css-file, --js-file, --remove
  const content = args.slice(1).join(' ');

  if (type === '--remove') {
    const selector = content
      ? `[data-cdp-inject="${content}"]`
      : '[data-cdp-inject]';
    return evalStr(cdp, sid, `(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      els.forEach(el => el.remove());
      return els.length + ' element(s) removed';
    })()`);
  }

  if (type === '--css') {
    return evalStr(cdp, sid, `(() => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const s = document.createElement('style');
      s.setAttribute('data-cdp-inject', id);
      s.textContent = ${JSON.stringify(content)};
      document.head.appendChild(s);
      return id;
    })()`);
  }

  if (type === '--css-file') {
    return evalStr(cdp, sid, `new Promise((resolve, reject) => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = ${JSON.stringify(content)};
      link.setAttribute('data-cdp-inject', id);
      link.onload = () => resolve(id);
      link.onerror = () => reject(new Error('Failed to load stylesheet'));
      document.head.appendChild(link);
    })`);
  }

  if (type === '--js-file') {
    return evalStr(cdp, sid, `new Promise((resolve, reject) => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const s = document.createElement('script');
      s.src = ${JSON.stringify(content)};
      s.setAttribute('data-cdp-inject', id);
      s.onload = () => resolve(id);
      s.onerror = () => reject(new Error('Failed to load script'));
      document.head.appendChild(s);
    })`);
  }

  throw new Error('inject requires --css, --css-file, --js-file, or --remove');
}
```

### Tests

- `--css`: injected `<style>` has `data-cdp-inject` attribute
- `--css-file`: creates `<link>` with onload wait
- `--js-file`: creates `<script>` with onload wait
- `--remove`: clears all injected elements
- `--remove inject-2`: removes only specific injection
- Error: missing flag throws descriptive error

---

## `cascade` — CSS Origin Tracing (Cognitive)

### Problem

Agent sees `background-color: blue` from `styles` command but has no
idea WHERE that rule is defined. It can't answer "which file do I edit
to change this button's color?" — the most fundamental frontend dev
question.

### Why eval can't do this

`window.getComputedStyle()` only returns final computed values.
**It does not expose which CSS rule applied the value, which file
it's in, or what specificity won it.** This information is only
available via CDP's `CSS.getMatchedStylesForNode`, which returns the
full cascade with source locations.

### Design

```
cascade <target> <selector|@ref>                  # full cascade for element
cascade <target> <selector|@ref> <property>        # cascade for one property
```

### Output

```
<button.btn-primary> background-color: #2563eb

Cascade (most specific → least):
  ✓ .btn-primary { background-color: #2563eb }
    → src/styles/components.css:142  specificity: (0,1,0)

  ✗ .btn { background-color: #e5e7eb }            [overridden]
    → src/styles/base.css:89         specificity: (0,1,0)  — same specificity, loses by source order

  ✗ button { background-color: ButtonFace }        [overridden]
    → user-agent stylesheet           specificity: (0,0,1)

Inherited properties:
  color: #1f2937  ← from body { color: #1f2937 }
    → src/styles/base.css:12
  font-family: Inter  ← from :root { font-family: Inter }
    → src/styles/base.css:2
```

### Implementation

```javascript
async function cascadeStr(cdp, sid, selector, property, refMap) {
  // Step 1: Resolve element to DOM nodeId
  let nodeId;
  if (isRef(selector)) {
    const backendNodeId = refMap.get(parseInt(selector.slice(1)));
    if (!backendNodeId) throw new Error(`Unknown ref: ${selector}`);
    const { nodeId: nid } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend',
      { backendNodeIds: [backendNodeId] }, sid);
    nodeId = nid[0];
  } else {
    const { root } = await cdp.send('DOM.getDocument', {}, sid);
    const result = await cdp.send('DOM.querySelector',
      { nodeId: root.nodeId, selector }, sid);
    if (!result.nodeId) throw new Error('Element not found: ' + selector);
    nodeId = result.nodeId;
  }

  // Step 2: Get matched styles (the cascade)
  const matched = await cdp.send('CSS.getMatchedStylesForNode',
    { nodeId }, sid);

  // Step 3: Get computed style for the "winner" display
  const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode',
    { nodeId }, sid);

  // Step 4: Format output
  return formatCascade(matched, computedStyle, property);
}

function formatCascade(matched, computedStyle, filterProperty) {
  const lines = [];

  // Group rules by property
  const propertyRules = new Map(); // property → [{value, source, specificity, active}]

  for (const match of matched.matchedCSSRules || []) {
    const rule = match.rule;
    const source = formatSource(rule);
    const specificity = formatSpecificity(match.matchingSelectors, rule);

    for (const prop of rule.style.cssProperties || []) {
      if (prop.name.startsWith('-')) continue; // skip vendor prefixes
      if (filterProperty && prop.name !== filterProperty) continue;
      if (!propertyRules.has(prop.name)) propertyRules.set(prop.name, []);
      propertyRules.get(prop.name).push({
        value: prop.value,
        selector: rule.selectorList?.text || '?',
        source,
        specificity,
        disabled: prop.disabled,
      });
    }
  }

  // For each property, show the winner and losers
  for (const [prop, rules] of propertyRules) {
    // Find computed value (the winner)
    const computed = computedStyle.find(c => c.name === prop);
    if (!computed) continue;

    lines.push(`${prop}: ${computed.value}`);
    for (const r of rules) {
      const active = r.value === computed.value && !r.disabled;
      const mark = active ? '✓' : '✗';
      const note = active ? '' : '  [overridden]';
      lines.push(`  ${mark} ${r.selector} { ${prop}: ${r.value} }${note}`);
      lines.push(`    → ${r.source}  specificity: ${r.specificity}`);
    }
    lines.push('');
  }

  // Inherited properties
  if (matched.inherited?.length > 0) {
    lines.push('Inherited:');
    for (const inh of matched.inherited) {
      if (!inh.matchedCSSRules?.length) continue;
      for (const match of inh.matchedCSSRules) {
        for (const prop of match.rule.style.cssProperties || []) {
          if (filterProperty && prop.name !== filterProperty) continue;
          if (!isInheritableProperty(prop.name)) continue;
          const source = formatSource(match.rule);
          lines.push(`  ${prop.name}: ${prop.value}  ← ${source}`);
        }
      }
    }
  }

  return lines.join('\n') || 'No matching CSS rules found';
}

function formatSource(rule) {
  if (!rule.styleSheetId) return 'inline style';
  // CDP provides source URL and line/column in range
  const range = rule.selectorList?.selectors?.[0]?.range;
  const line = range ? `:${range.startLine + 1}` : '';
  return `${rule.origin === 'user-agent' ? 'user-agent stylesheet' : (rule.styleSheetId + line)}`;
}

function formatSpecificity(selectors, rule) {
  // CDP provides specificity in the selector data
  return '(computed)'; // Simplified — full implementation parses selector
}

const INHERITABLE = new Set([
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-indent',
  'text-transform', 'white-space', 'word-spacing', 'visibility',
  'cursor', 'direction', 'list-style',
]);
function isInheritableProperty(name) { return INHERITABLE.has(name); }
```

### Prerequisites

Requires `CSS.enable` in the daemon initialization (alongside the
existing `DOM.enable`, `Runtime.enable`, etc.).

### Tests

- Basic: mock `CSS.getMatchedStylesForNode` → verify output format
- Filter by property: only `background-color` shown
- Inherited properties: `color` traced to ancestor
- No matches: descriptive message returned
- @ref support: resolves ref to nodeId correctly

---

# v2.3.0 — Emulate + Record

## `emulate` — Network & Theme Emulation (Operational)

### Problem

Testing slow network, offline, or dark mode requires CDP protocol
domains inaccessible from page JavaScript.

### Why eval can't do this

- `Network.emulateNetworkConditions` throttles the browser's actual
  network stack — no JS equivalent
- `Emulation.setEmulatedMedia` overrides `prefers-color-scheme` —
  `window.matchMedia` is read-only

### Design

```
emulate <target> slow3g            # 400kbps down, 400ms RTT
emulate <target> fast3g            # 1.5Mbps down, 150ms RTT
emulate <target> offline           # no connectivity
emulate <target> online            # restore normal network
emulate <target> dark              # prefers-color-scheme: dark
emulate <target> light             # prefers-color-scheme: light
emulate <target> reset             # remove all overrides
```

### Implementation

```javascript
const NETWORK_PRESETS = {
  slow3g:  { offline: false, latency: 400,  downloadThroughput: 50000,   uploadThroughput: 25000   },
  fast3g:  { offline: false, latency: 150,  downloadThroughput: 187500,  uploadThroughput: 75000   },
  offline: { offline: true,  latency: 0,    downloadThroughput: 0,       uploadThroughput: 0       },
  online:  { offline: false, latency: 0,    downloadThroughput: -1,      uploadThroughput: -1      },
};

async function emulateStr(cdp, sid, preset) {
  if (!preset) throw new Error('Preset required: slow3g, fast3g, offline, online, dark, light, reset');
  const key = preset.toLowerCase();

  if (key === 'reset') {
    await cdp.send('Network.emulateNetworkConditions', NETWORK_PRESETS.online, sid);
    await cdp.send('Emulation.setEmulatedMedia', { media: '', features: [] }, sid);
    return 'All emulation overrides removed';
  }

  if (key === 'dark' || key === 'light') {
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: key }],
    }, sid);
    return `Emulating prefers-color-scheme: ${key}`;
  }

  const net = NETWORK_PRESETS[key];
  if (!net) throw new Error(`Unknown preset: ${preset}. Use: slow3g, fast3g, offline, online, dark, light, reset`);
  await cdp.send('Network.emulateNetworkConditions', net, sid);
  return `Network: ${key}` + (net.offline ? ' (no connectivity)' : ` (${Math.round(net.downloadThroughput * 8 / 1000)}kbps, ${net.latency}ms RTT)`);
}
```

### Action Feedback

- `dark`/`light`: auto-returns perceive diff (visual change)
- Network presets: no auto-diff (agent should `reload` to see effect)

### Tests

- Each preset: verify correct CDP method + params
- `reset`: verify both domains reset
- Unknown preset: descriptive error with valid list

---

## `record` — Timeline Recording (Temporal)

### Problem

Every command is a point-in-time snapshot. Agent cannot answer:
- "What happened in the 3 seconds after I clicked Submit?"
- "When did the page become stable after navigation?"
- "What API calls triggered what DOM changes?"

Agent has no **temporal awareness** — no understanding of causality,
sequence, or page lifecycle.

### Why this is a genuine gap

The daemon already collects events into ring buffers (console, network,
navigation, exceptions). But there is no command that says "record
everything for N seconds and produce a temporal summary." The agent
must poll `status` + `netlog` + `console` manually and reconstruct
the timeline itself — losing sub-second precision and causal ordering.

### Design

```
record <target> <ms>                     # record for N milliseconds (max 30s)
record <target> --until "dom stable"     # record until DOM settles (max 30s)
record <target> --until "network idle"   # record until no pending requests (max 30s)
record <target> --action click @5        # record while performing an action
```

### Output

```
Timeline: 3.2s recorded (triggered by: click @5 "Submit")

  0ms   [action] Clicked <button> "Submit" @5
  12ms  [dom] +8 nodes (form validation feedback)
  45ms  [net] POST /api/submit → pending
  52ms  [dom] +2 nodes (loading spinner appeared)
  380ms [net] POST /api/submit → 201 (335ms, 1.2KB)
  395ms [dom] -2 nodes (spinner removed), +5 nodes (success message)
  400ms [anim] .toast opacity 0→1 (200ms ease-out)
  600ms [anim] complete
  950ms DOM stable (no mutations for 550ms)

Summary:
  Duration: 950ms (action → stable)
  Network: 1 request (POST 201, 335ms)
  DOM: 3 mutation bursts (15 added, 2 removed)
  Animations: 1 CSS transition
  Console: clean
  Verdict: ✓ page settled in <1s after action
```

### Implementation

The daemon already has the event infrastructure. `record` adds a
temporary high-resolution event collector on top:

```javascript
async function recordStr(cdp, sid, args, consoleBuf, exceptionBuf, netReqBuf, refMap) {
  const events = [];   // [{ts, type, detail}]
  let startTs;

  // Parse args
  let durationMs = 5000;
  let untilCondition = null;
  let action = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--until') untilCondition = args[++i];
    else if (args[i] === '--action') action = { cmd: args[++i], args: args.slice(i + 1) };
    else durationMs = Math.min(parseInt(args[i]) || 5000, 30000);
  }

  // Set up high-resolution event collectors
  const domObserverExpr = `(() => {
    window.__cdp_record = { mutations: [], settled: false };
    const buf = window.__cdp_record.mutations;
    let timer;
    const obs = new MutationObserver((muts) => {
      const ts = performance.now();
      let added = 0, removed = 0, attrs = 0;
      for (const m of muts) {
        added += m.addedNodes.length;
        removed += m.removedNodes.length;
        if (m.type === 'attributes') attrs++;
      }
      buf.push({ ts: Math.round(ts), added, removed, attrs });
      clearTimeout(timer);
      timer = setTimeout(() => { window.__cdp_record.settled = true; }, 500);
    });
    obs.observe(document.body || document.documentElement,
      { childList: true, subtree: true, attributes: true });
    return 'recording';
  })()`;
  await evalStr(cdp, sid, domObserverExpr);

  // Snapshot ring buffer positions before recording
  const consoleSeqBefore = consoleBuf.latest();
  const netSeqBefore = netReqBuf.latest();

  startTs = Date.now();

  // Perform action if specified
  if (action) {
    // Execute the action command (click, fill, press, etc.)
    // Record it as the first event
    events.push({ ts: 0, type: 'action', detail: `${action.cmd} ${action.args.join(' ')}` });
  }

  // Wait for duration or condition
  const deadline = startTs + durationMs;
  while (Date.now() < deadline) {
    if (untilCondition === 'dom stable') {
      const settled = await evalStr(cdp, sid, 'window.__cdp_record?.settled || false');
      if (settled === 'true') break;
    }
    if (untilCondition === 'network idle') {
      // Check if no pending requests (simple heuristic)
      const pending = await evalStr(cdp, sid,
        'performance.getEntriesByType("resource").filter(e => e.responseEnd === 0).length');
      if (pending === '0') {
        await sleep(200);  // confirm idle
        break;
      }
    }
    await sleep(100);
  }

  const elapsed = Date.now() - startTs;

  // Collect DOM mutation data
  const domData = JSON.parse(await evalStr(cdp, sid,
    'JSON.stringify(window.__cdp_record?.mutations || [])'));

  // Cleanup observer
  await evalStr(cdp, sid, `(() => {
    delete window.__cdp_record;
  })()`).catch(() => {});

  // Collect console and network events that occurred during recording
  const newConsole = consoleBuf.since(consoleSeqBefore);
  const newNet = netReqBuf.since(netSeqBefore);

  // Merge all events into timeline
  for (const m of domData) {
    events.push({
      ts: m.ts,
      type: 'dom',
      detail: `+${m.added} -${m.removed}${m.attrs ? ` ~${m.attrs} attrs` : ''}`,
    });
  }
  for (const e of newConsole) {
    events.push({ ts: e.ts - startTs, type: 'console', detail: `[${e.level}] ${e.text.substring(0, 100)}` });
  }
  for (const e of newNet) {
    events.push({ ts: e.ts - startTs, type: 'net', detail: `${e.method} ${e.url.substring(0, 80)} → ${e.status} (${e.duration}ms)` });
  }

  // Sort by timestamp
  events.sort((a, b) => a.ts - b.ts);

  // Format output
  const lines = [];
  const trigger = action ? `triggered by: ${action.cmd} ${action.args.join(' ')}` : 'passive recording';
  lines.push(`Timeline: ${(elapsed / 1000).toFixed(1)}s recorded (${trigger})\n`);

  for (const e of events) {
    const ts = String(Math.round(e.ts)).padStart(5) + 'ms';
    lines.push(`  ${ts}  [${e.type}] ${e.detail}`);
  }

  // Summary
  const domTotal = domData.reduce((s, m) => s + m.added + m.removed, 0);
  const domBursts = domData.length;
  lines.push('');
  lines.push('Summary:');
  lines.push(`  Duration: ${elapsed}ms`);
  lines.push(`  Network: ${newNet.length} request(s)`);
  lines.push(`  DOM: ${domTotal} mutations in ${domBursts} burst(s)`);
  lines.push(`  Console: ${newConsole.length} entries`);

  // Detect when page settled
  if (domData.length > 0) {
    const lastMut = domData[domData.length - 1];
    const settleGap = elapsed - lastMut.ts;
    if (settleGap > 300) {
      lines.push(`  Settled: ${Math.round(lastMut.ts)}ms (idle for ${Math.round(settleGap)}ms)`);
    }
  }

  return lines.join('\n');
}
```

### Key Capabilities

| Mode | Use Case |
|------|----------|
| `record <t> 5000` | Passive observation — "what's happening on this page?" |
| `record <t> --until "dom stable"` | Wait for page to finish loading/rendering |
| `record <t> --until "network idle"` | Wait for all API calls to complete |
| `record <t> --action click @5` | **Cause-and-effect** — see exactly what a click triggered |

The `--action` mode is the most powerful: it lets the agent understand
**causality** — "clicking Submit caused a POST, which returned 201,
which triggered a DOM update that added a success toast."

### Tests

- Basic: verify timeline output format with mock events
- `--until "dom stable"`: verify early exit when MutationObserver settles
- `--action`: verify action is recorded as first event
- Event ordering: verify chronological sort across types
- Summary stats: verify correct counts
- Cleanup: verify `__cdp_record` is removed after recording
- Max duration: verify 30s cap

---

# v2.4.0 — Frame + Components

## `frame` — Cross-Origin Iframe Access (Operational)

### Problem

Cross-origin iframes (Stripe payment forms, OAuth popups, embedded
widgets) are invisible to `perceive` and `eval`. The Same-Origin
Policy blocks JavaScript access, but CDP can attach to any frame.

### Why eval can't do this

Cross-origin iframe DOM is completely inaccessible from parent frame
JavaScript. CDP's `Page.createIsolatedWorld` can grant access that
page JS cannot.

### Design

```
frame <target> list                     # list all frames with origin info
frame <target> <frameId> perceive       # perceive inside a frame
frame <target> <frameId> eval <expr>    # eval inside a frame
frame <target> <frameId> snap           # AX tree of a frame
frame <target> <frameId> text [sel]     # text extraction from frame
frame <target> <frameId> html [sel]     # HTML from frame
```

Only observation commands — interaction (`click`, `type`, `press`)
already works cross-frame via Input.dispatch* (coordinate-based, not
JS-based).

### Output: `frame list`

```
A1B2C3D4E5F6  (main)     https://myapp.com/checkout
  F7G8H9I0    payment     https://js.stripe.com/v3/elements  [cross-origin]
  J1K2L3M4    analytics   https://www.google-analytics.com   [cross-origin]
  N5O6P7Q8    chat        https://myapp.com/chat-widget
```

### Implementation

```javascript
async function frameListStr(cdp, sid) {
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, sid);
  const mainOrigin = frameTree.frame.securityOrigin;
  const lines = [];

  function walk(node, depth) {
    const f = node.frame;
    const indent = '  '.repeat(depth);
    const cross = depth > 0 && f.securityOrigin !== mainOrigin
      ? '  [cross-origin]' : '';
    const name = f.name || (depth === 0 ? '(main)' : '(unnamed)');
    lines.push(`${indent}${f.id.slice(0, 12)}  ${name.padEnd(14)}  ${f.url.substring(0, 60)}${cross}`);
    for (const child of node.childFrames || []) walk(child, depth + 1);
  }

  walk(frameTree, 0);
  return lines.join('\n');
}

async function frameCommandStr(cdp, sid, frameId, cmd, args) {
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, sid);
  const frame = findFrameByPrefix(frameTree, frameId);
  if (!frame) throw new Error(`Frame not found: ${frameId}. Run "frame <target> list".`);

  // Create isolated world for cross-origin access
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
    frameId: frame.id, worldName: 'cdp-frame', grantUniveralAccess: true,
  }, sid);

  switch (cmd) {
    case 'perceive':
      // Scoped AX tree via frame's root backendNodeId
      return perceiveInFrame(cdp, sid, frame, executionContextId);
    case 'eval':
      return evalInContext(cdp, sid, executionContextId, args.join(' '));
    case 'text':
      return textInContext(cdp, sid, executionContextId, args[0]);
    case 'html':
      return htmlInContext(cdp, sid, executionContextId, args[0]);
    case 'snap':
      return snapInFrame(cdp, sid, frame);
    default:
      throw new Error(`Unsupported frame command: ${cmd}. Use: perceive, eval, text, html, snap`);
  }
}
```

### Phased Delivery

- **v2.4.0-beta**: Ship `frame list` only — validate frame discovery
- **v2.4.0**: Add `frame <id> perceive` and `frame <id> eval` after
  testing against real cross-origin iframes (Stripe, Google OAuth)

### Tests

- `frame list`: verify tree output format
- Cross-origin annotation: verify `[cross-origin]` appears
- Frame prefix resolution: same logic as `resolvePrefix`
- Unknown frame: error with hint to run `frame list`

---

## `components` — Framework Component Tree + State (Cognitive)

### Problem

Agent sees DOM elements (`div`, `span`, `button`) but not the
developer's mental model (`<UserProfile>`, `<ShoppingCart>`,
`<PaymentForm>`). It also cannot see component state — it sees a
spinner but doesn't know `loading: true` is the cause.

### Why eval isn't enough (but is the mechanism)

Framework DevTools hooks ARE accessible via `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`
and `__VUE_DEVTOOLS_GLOBAL_HOOK__`. But the extraction logic is
complex enough to warrant a dedicated command:

- React fiber tree traversal requires walking `_reactFiber` on DOM nodes
- Vue component tree requires `__vue_app__` or `__vue__` access
- State serialization must handle circular references and large objects
- Component name extraction differs between dev/prod builds

### Design

```
components <target>                    # detect framework + show component tree
components <target> @3                 # show props/state for component at @ref
components <target> --depth 2          # limit tree depth
```

### Output: Component Tree

```
[React 18.3.1 detected]

<App>
  <Header>
    <NavLink to="/" active>  @1
    <NavLink to="/about">  @2
  <Main>
    <UserProfile userId={42} loading={false}>
      <Avatar size="lg">
      <Bio text="Hello world">
    <Sidebar>
      <RecentPosts count={5}>
  <Footer>
    <Copyright year={2026}>
```

### Output: Component State (`components <target> @3`)

```
Component: <UserProfile>
  Props: { userId: 42, showAvatar: true }
  State: { loading: false, error: null, data: { name: "Alice", email: "..." } }
  Context: { theme: "dark", locale: "zh-TW" }
  Hooks:
    useState[0]: false  (loading)
    useState[1]: { name: "Alice", ... }  (data)
    useEffect[0]: active (deps: [42])
```

### Implementation Sketch

```javascript
const FRAMEWORK_DETECTORS = `(function() {
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size > 0) {
    const version = Array.from(window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.values())[0]?.version;
    return { framework: 'react', version };
  }
  if (window.__VUE__) return { framework: 'vue', version: window.__VUE__.version };
  if (document.querySelector('[ng-version]'))
    return { framework: 'angular', version: document.querySelector('[ng-version]').getAttribute('ng-version') };
  return null;
})()`;

async function componentsStr(cdp, sid, args, refMap) {
  // Detect framework
  const detection = JSON.parse(await evalStr(cdp, sid, FRAMEWORK_DETECTORS));
  if (!detection) return 'No supported framework detected (React, Vue, or Angular required)';

  if (args[0] && isRef(args[0])) {
    // Component state for specific element
    return componentStateStr(cdp, sid, detection.framework, args[0], refMap);
  }

  const maxDepth = args.includes('--depth') ? parseInt(args[args.indexOf('--depth') + 1]) : 8;

  // Framework-specific tree extraction
  switch (detection.framework) {
    case 'react': return reactTreeStr(cdp, sid, detection.version, maxDepth);
    case 'vue': return vueTreeStr(cdp, sid, detection.version, maxDepth);
    default: return `${detection.framework} ${detection.version} detected but tree extraction not yet supported`;
  }
}

async function reactTreeStr(cdp, sid, version, maxDepth) {
  // Walk React fiber tree from root
  return evalStr(cdp, sid, `(function() {
    const roots = document.querySelectorAll('[data-reactroot], #root, #__next, #app');
    for (const root of roots) {
      const key = Object.keys(root).find(k => k.startsWith('__reactFiber'));
      if (!key) continue;
      const fiber = root[key];

      const lines = [];
      function walk(fiber, depth) {
        if (!fiber || depth > ${maxDepth}) return;
        const name = fiber.type?.displayName || fiber.type?.name || fiber.type;
        if (typeof name !== 'string' || name.length > 50) {
          // Skip anonymous wrappers, walk children
          if (fiber.child) walk(fiber.child, depth);
          if (fiber.sibling) walk(fiber.sibling, depth);
          return;
        }
        // Extract key props (skip functions, limit depth)
        let propsStr = '';
        if (fiber.memoizedProps) {
          const parts = [];
          for (const [k, v] of Object.entries(fiber.memoizedProps)) {
            if (typeof v === 'function') continue;
            if (k === 'children') continue;
            const s = typeof v === 'object' ? JSON.stringify(v).substring(0, 30) : String(v);
            parts.push(k + '=' + (typeof v === 'string' ? '"' + s + '"' : '{' + s + '}'));
            if (parts.length >= 4) { parts.push('...'); break; }
          }
          if (parts.length > 0) propsStr = ' ' + parts.join(' ');
        }
        lines.push('  '.repeat(depth) + '<' + name + propsStr + '>');
        if (fiber.child) walk(fiber.child, depth + 1);
        if (fiber.sibling) walk(fiber.sibling, depth);
      }
      if (fiber) walk(fiber, 0);
      if (lines.length > 0) return '[React ' + ${JSON.stringify(version)} + ']\\n\\n' + lines.join('\\n');
    }
    return 'React detected but no component tree found (production build may strip fiber data)';
  })()`);
}
```

### Limitations

- **Production builds**: React prod builds strip component names (show
  as single letters). Works best with dev builds or source maps.
- **Framework coverage**: React and Vue first. Angular and Svelte later.
- **State serialization**: Large state objects are truncated to prevent
  token bloat (max 500 chars per value).

### Tests

- Framework detection: mock `__REACT_DEVTOOLS_GLOBAL_HOOK__` → verify React detected
- No framework: verify descriptive "not detected" message
- Tree depth limit: verify `--depth 2` stops at depth 2
- Component state: mock fiber with memoizedProps → verify formatted output
- Prod build fallback: verify graceful message when names are stripped

---

# Design Principles (All Features)

### Single-file constraint

All implementation in `cdp.mjs`. No new files, no dependencies.

### 5-place registration

Every command: function, `handleCommand`, `NEEDS_TARGET`, `USAGE`, `README.md`.

### Test-export pattern

Add to `__test__` export (grouped by category).

### Error messages

Descriptive message + actionable hint.

### Output format

Plain text strings following existing conventions.
