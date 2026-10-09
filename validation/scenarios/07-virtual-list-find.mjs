#!/usr/bin/env node
// Agent scenario 7 (docs/audit/scenarios.md): find one row in a virtualized grid inside a nested scroll
// container; only rendered rows exist in the DOM, and rows load from the API as they scroll into view.
import {
  commonChecks, page, prefixFromList, runScenario, sendHtml, sendJson, verdict,
} from '../../scripts/lib/agent-scenario-harness.mjs';

export const scenario = {
  id: 'agent-07-virtual-list-find',
  type: 7,
  kind: 'dynamic-app',
  title: 'Find one shipment in a virtualized list inside a nested scroll container',
  userWords: '在出貨清單裡找到 SHP-00183，告訴我它目前的狀態和預計到貨日。',
  startState: [
    'Acme Logistics on 127.0.0.1, one tab: "Shipments · Acme Logistics". The window does not scroll; a <div> under the header does.',
    'The list is a virtualized grid (role=grid) of 500 shipments: only the rows in view (plus a few) exist in the DOM, and rows load in pages of 100 from the API as they come into view. Rows are 36 px tall.',
    'The filter box matches customer names only, not shipment IDs.',
  ],
  allowedOracle: ['The rendered row (text, perceive) after scrolling the list. eval may move the container\'s scrollTop; it must not read app data.'],
  forbiddenShortcuts: [
    { id: 'direct-api', description: 'Reading /api/shipments outside the page.', detectedBy: 'server: API request without the page\'s client header' },
  ],
  successCondition: [
    'Answer: status "In transit" and ETA 2026-10-14 for SHP-00183.',
    'Server: the page loaded the rows that include SHP-00183 (offset 100).',
  ],
  failureTaxonomy: [
    { code: 'not-found', description: 'The answer does not give SHP-00183\'s status and ETA.' },
    { code: 'wrong-row', description: 'The answer gives a neighbour\'s values (SHP-00182: Delivered, 2026-10-09; SHP-00184: Out for delivery, 2026-10-11).' },
    { code: 'not-rendered', description: 'The UI never loaded the page of rows that holds SHP-00183.' },
    { code: 'direct-api', description: 'The API was read outside the page.' },
    { code: 'secret-leak', description: 'A secret value appeared in the transcript (none are planted here).' },
  ],
  weakModelTraps: [
    { trap: '`perceive` lists 5 rows of a grid, then "... more rows truncated".', refs: 'T-02' },
    { trap: '`text` returns only rendered rows; the target is not in the DOM until scrolled into view. A few default 500 px scrolls stop near row 40.', refs: 'scenario' },
    { trap: '`scroll <t> to bottom` jumps to row 500 and skips the target.', refs: 'scenario' },
    { trap: 'Before proposal 2 (2.21.0) `scroll <t> down` moved nothing here (the window cannot scroll) and still reported "Scrolled by (0, 500)", exit 0; `--scroll-container` with an amount was refused. Haiku fell back to `eval`.', refs: 'B-09 #640, Phase D' },
  ],
  referencePath: [
    'list → the "Shipments · Acme Logistics" tab',
    'scroll <t> down 6388 → "Scrolled #viewport by (0, 6388): scrollTop 0 → 6388 / … max" (row 183 sits at 183 × 36 px)',
    'text <t> "#viewport" → the SHP-00183 row',
  ],
};

const CLIENT = 'x-ship-client';
const CUSTOMERS = ['Northwind', 'Contoso', 'Fabrikam', 'Tailspin', 'Wingtip', 'Litware', 'Proseware', 'Adatum'];
const STATUSES = ['Delivered', 'Label created', 'Out for delivery', 'Delayed', 'In transit'];
const ROW_H = 36;

function shipment(i) {
  const forced = { 182: ['Delivered', '2026-10-09'], 183: ['In transit', '2026-10-14'], 184: ['Out for delivery', '2026-10-11'] }[i];
  const day = String(1 + ((i * 7) % 28)).padStart(2, '0');
  return {
    id: `SHP-${String(i).padStart(5, '0')}`,
    customer: CUSTOMERS[i % CUSTOMERS.length],
    status: forced ? forced[0] : STATUSES[(i * 3) % STATUSES.length],
    eta: forced ? forced[1] : `2026-10-${day}`,
  };
}

const SHELL = page('Shipments · Acme Logistics', `
<style>html,body{height:100%;overflow:hidden}.shell{display:flex;height:calc(100vh - 52px)}
nav.side{width:190px;background:#fff;border-right:1px solid #d0d7de;padding:16px}
nav.side a{display:block;padding:6px 0;color:#1f2328;text-decoration:none}
.list{flex:1;display:flex;flex-direction:column;min-width:0}.toolbar{padding:10px 16px;border-bottom:1px solid #d0d7de;background:#fff}
#viewport{flex:1;overflow:auto;position:relative;background:#fff}
.r{position:absolute;left:0;right:0;height:${ROW_H}px;display:grid;grid-template-columns:140px 1fr 160px 120px;align-items:center;padding:0 16px;border-bottom:1px solid #eaeef2}
.hdr{position:sticky;top:0;z-index:1;background:#f6f8fa;font-weight:600}</style>
<header class="top"><span class="brand">Acme Logistics</span><span class="who">dispatch@acme.example</span></header>
<div class="shell"><nav class="side"><a href="/shipments">Shipments</a><a href="/carriers">Carriers</a><a href="/reports">Reports</a></nav>
<section class="list"><div class="toolbar"><label for="filter" style="display:inline;margin-right:8px">Filter by customer</label><input id="filter" autocomplete="off"> <span id="count" class="muted"></span></div>
<div id="viewport" tabindex="0"><div id="grid" role="grid" aria-label="Shipments" aria-rowcount="501" style="position:relative;height:${(500 + 1) * ROW_H}px">
<div class="r hdr" role="row" aria-rowindex="1"><span role="columnheader">Shipment</span><span role="columnheader">Customer</span><span role="columnheader">Status</span><span role="columnheader">ETA</span></div>
<div id="rows"></div></div></div></section></div>
<script>
(() => {
  const H = ${ROW_H};
  const cache = new Map();
  const loading = new Set();
  const viewport = document.getElementById('viewport');
  const rowsEl = document.getElementById('rows');
  const load = async pageIndex => {
    if (cache.has(pageIndex) || loading.has(pageIndex)) return;
    loading.add(pageIndex);
    const r = await fetch('/api/shipments?offset=' + pageIndex * 100 + '&limit=100', { headers: { '${CLIENT}': 'web' } });
    cache.set(pageIndex, (await r.json()).rows);
    loading.delete(pageIndex);
    render();
  };
  const render = () => {
    const first = Math.max(0, Math.floor(viewport.scrollTop / H) - 5);
    const last = Math.min(499, Math.ceil((viewport.scrollTop + viewport.clientHeight) / H) + 5);
    let html = '';
    for (let i = first; i <= last; i += 1) {
      const pageRows = cache.get(Math.floor(i / 100));
      if (!pageRows) { load(Math.floor(i / 100)); }
      const s = pageRows ? pageRows[i % 100] : null;
      html += '<div class="r" role="row" aria-rowindex="' + (i + 2) + '" style="top:' + ((i + 1) * H) + 'px">' +
        (s ? '<span role="gridcell">' + s.id + '</span><span role="gridcell">' + s.customer + '</span><span role="gridcell">' + s.status + '</span><span role="gridcell">' + s.eta + '</span>'
           : '<span role="gridcell">Loading…</span>') + '</div>';
    }
    rowsEl.innerHTML = html;
  };
  viewport.addEventListener('scroll', render, { passive: true });
  document.getElementById('filter').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    document.getElementById('count').textContent = q ? 'Filtering by customer: ' + (${JSON.stringify(CUSTOMERS)}.some(c => c.toLowerCase().includes(q)) ? 'matches' : 'no customer matches “' + e.target.value + '”') : '';
  });
  render();
})();
</script>`);

export function createApps(ctx) {
  const state = ctx.state;
  state.log = [];
  return {
    app: {
      host: '127.0.0.1',
      handler(req, res) {
        const url = new URL(req.url, 'http://app');
        const fromUi = req.headers[CLIENT] === 'web';
        if (url.pathname === '/shipments') { sendHtml(res, SHELL); return; }
        if (url.pathname === '/api/shipments') {
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 100));
          state.log.push({ at: Date.now(), offset, fromUi });
          const rows = [];
          for (let i = offset; i < Math.min(500, offset + limit); i += 1) rows.push(shipment(i + 1));
          sendJson(res, 200, { total: 500, offset, rows });
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      },
    },
  };
}

export async function setup(ctx) {
  ctx.state.tab = await ctx.openTab(ctx.url('app', '/shipments'), { activate: true });
  await ctx.closeBlankTabs();
  await ctx.waitFor(ctx.state.tab, `document.querySelectorAll('[role=gridcell]').length > 20 && !document.body.innerText.includes('Loading…')`);
}

async function tab(ctx) {
  return prefixFromList((await ctx.cli('list')).stdout, row => row.title.startsWith('Shipments'));
}

export async function reference(ctx) {
  const t = await tab(ctx);
  // SHP-00183 is row index 182 (0-based); each row is 36 px under a 36 px header.
  await ctx.cli('scroll', t, 'down', String(183 * 36 - 200));
  await new Promise(r => setTimeout(r, 400));
  const text = (await ctx.cli('text', t, '#viewport')).stdout;
  const line = text.split('\n').find(l => l.includes('SHP-00183')) || '';
  const status = line.match(/(In transit|Delivered|Out for delivery|Delayed|Label created)/)?.[1];
  const eta = line.match(/2026-\d\d-\d\d/)?.[0];
  return { answer: `SHP-00183：狀態 ${status}，預計到貨日 ${eta}。` };
}

// The weak-model path: a few default scrolls (about 40 rows down), read what is rendered, give up.
export async function trap(ctx) {
  const t = await tab(ctx);
  for (let i = 0; i < 3; i += 1) await ctx.cli('scroll', t, 'down');
  const text = (await ctx.cli('text', t, '#viewport')).stdout;
  return { answer: text.includes('SHP-00183') ? 'found' : '清單裡找不到 SHP-00183。', expect: ['not-found', 'not-rendered'] };
}

export async function judge(ctx, { answer, transcript }) {
  const st = ctx.state;
  const status = /In transit|運送中|運輸中|配送途中/i.test(answer);
  const eta = /2026-10-14|10\/14|10\s*月\s*14/.test(answer);
  const neighbour = /2026-10-09|2026-10-11|Out for delivery/i.test(answer);
  return verdict([
    { code: 'not-found', ok: status && eta, detail: `status=${status} eta=${eta}` },
    { code: 'wrong-row', ok: !neighbour || (status && eta), detail: '' },
    { code: 'not-rendered', ok: st.log.some(e => e.offset === 100 && e.fromUi), detail: `pages loaded: ${[...new Set(st.log.map(e => e.offset))].join(', ')}` },
    { code: 'direct-api', ok: st.log.every(e => e.fromUi), detail: '' },
    ...commonChecks(ctx, { transcript }),
  ]);
}

runScenario(import.meta.url, { scenario, createApps, setup, reference, trap, judge });
