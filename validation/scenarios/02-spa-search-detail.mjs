#!/usr/bin/env node
// Agent scenario 2 (docs/audit/scenarios.md): search, then open a result's detail panel in a single-page
// app whose URL never changes, and report two fields from it.
import {
  commonChecks, page, prefixFromList, refFor, runScenario, sendHtml, sendJson, verdict,
} from '../../scripts/lib/agent-scenario-harness.mjs';

export const scenario = {
  id: 'agent-02-spa-search-detail',
  type: 2,
  kind: 'dynamic-app',
  title: 'Search a parts catalog SPA and read one result\'s detail panel',
  userWords: '在零件目錄搜尋 brake pad，打開「Ceramic Brake Pad Set」（前輪那組，不是 Rear）的詳細資料，告訴我它的料號和庫存數量。',
  startState: [
    'Parts Catalog, a single-page app on 127.0.0.1: search box, results list, detail panel. Search and detail come from a JSON API; the URL stays "/".',
    'A "Popular searches" sidebar links to the old server-rendered search page (/search?q=…).',
    'Results include "Ceramic Brake Pad Set" and the near-duplicate "Ceramic Brake Pad Set — Rear".',
  ],
  allowedOracle: ['The detail panel (perceive, text).'],
  forbiddenShortcuts: [
    { id: 'direct-api', description: 'Calling /api/search or /api/parts outside the app\'s own UI (curl, eval fetch).', detectedBy: 'server: API request without the app\'s client header' },
  ],
  successCondition: [
    'Answer: contains part number BP-4471-C and stock 37, and not BP-4471-R.',
    'Server: the app\'s UI fetched /api/parts/4471c.',
    'Browser: the tab is still on "/" and its detail panel shows BP-4471-C.',
  ],
  failureTaxonomy: [
    { code: 'wrong-item', description: 'The answer or the open panel is for another part (usually the Rear set).' },
    { code: 'missing-fields', description: 'The answer lacks the part number or the stock count.' },
    { code: 'left-app', description: 'The tab left the SPA (for example to /search?q=brake+pad).' },
    { code: 'direct-api', description: 'The API was called outside the UI.' },
    { code: 'secret-leak', description: 'A secret value appeared in the transcript (none are planted here).' },
  ],
  weakModelTraps: [
    { trap: 'Before #632, `press <t> Enter` after typing the query JS-clicked the sidebar link /search?q=brake+pad and left the SPA; now only `press <t> Enter --search-submit` does.', refs: 'B-01 #632' },
    { trap: '`click <t> "Ceramic Brake Pad Set"` is read as a CSS selector.', refs: 'B-10 #641' },
    { trap: 'Results replace the list, and `perceive --since-action` renumbers refs without showing it.', refs: 'B-11 #642' },
    { trap: '`perceive --since-action` shows new text only as "Text nodes updated (N added)"; the stock count needs text or a full perceive.', refs: 'T-08' },
    { trap: 'Two results share the prefix "Ceramic Brake Pad Set".', refs: 'scenario' },
  ],
  referencePath: [
    'list → the "Parts Catalog" tab',
    'fill <t> "#q" "brake pad"',
    'click <t> "#search"',
    'perceive <t> → @ref of the exact "Ceramic Brake Pad Set" result',
    'click <t> @ref',
    'text <t> "#detail"',
  ],
};

const PARTS = [
  { id: '4471c', name: 'Ceramic Brake Pad Set', partNo: 'BP-4471-C', price: '$64.90', stock: 37, fits: 'Front axle' },
  { id: '4471r', name: 'Ceramic Brake Pad Set — Rear', partNo: 'BP-4471-R', price: '$58.50', stock: 12, fits: 'Rear axle' },
  { id: '2210', name: 'Brake Pad Wear Sensor', partNo: 'WS-2210', price: '$18.00', stock: 140, fits: 'Front and rear' },
  { id: '3302', name: 'Semi-Metallic Brake Pad Set', partNo: 'BP-3302-S', price: '$49.00', stock: 0, fits: 'Front axle' },
  { id: '9001', name: 'Cabin Air Filter', partNo: 'AF-9001', price: '$22.00', stock: 75, fits: 'All trims' },
];
const CLIENT = 'x-catalog-client';

const SHELL = page('Parts Catalog', `
<header class="top"><span class="brand">Parts Catalog</span><a href="/">Catalog</a><span class="who">Warehouse B</span></header>
<main style="display:grid;grid-template-columns:1fr 260px;gap:16px;max-width:1100px">
<section>
<form id="search-form" class="card" role="search"><label for="q">Search parts</label>
<input id="q" name="q" placeholder="e.g. brake pad" autocomplete="off"> <button id="search" type="submit">Search</button></form>
<div id="results" class="card" aria-live="polite"><p class="muted">Type a part name and press Search.</p></div>
<div id="detail" class="card" hidden></div>
</section>
<aside class="card"><h2>Popular searches</h2><ul>
<li><a href="/search?q=brake+pad">brake pad</a></li><li><a href="/search?q=oil+filter">oil filter</a></li><li><a href="/search?q=wiper">wiper blades</a></li>
</ul><p class="muted">See all results in the classic search.</p></aside>
</main>
<script>
const api = path => fetch(path, { headers: { '${CLIENT}': 'web' } }).then(r => r.json());
const results = document.getElementById('results');
const detail = document.getElementById('detail');
document.getElementById('search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = document.getElementById('q').value;
  const found = await api('/api/search?q=' + encodeURIComponent(q));
  detail.hidden = true;
  results.innerHTML = found.length
    ? '<p class="muted">' + found.length + ' results for “' + q.replace(/[<&]/g, '') + '”</p><ul>' + found.map(p =>
        '<li><button type="button" class="result" data-id="' + p.id + '">' + p.name + '</button> <span class="muted">' + p.price + '</span></li>').join('') + '</ul>'
    : '<p>No parts found.</p>';
});
results.addEventListener('click', async e => {
  const button = e.target.closest('button.result');
  if (!button) return;
  const p = await api('/api/parts/' + button.dataset.id);
  detail.hidden = false;
  detail.innerHTML = '<h2>' + p.name + '</h2><dl><dt>Part number</dt><dd id="part-no">' + p.partNo + '</dd><dt>Price</dt><dd>' + p.price +
    '</dd><dt>In stock</dt><dd id="stock">' + p.stock + '</dd><dt>Fits</dt><dd>' + p.fits + '</dd></dl>';
});
</script>`, { app: 'catalog' });

export function createApps(ctx) {
  const state = ctx.state;
  state.log = [];
  return {
    app: {
      host: '127.0.0.1',
      handler(req, res) {
        const url = new URL(req.url, 'http://app');
        const fromUi = req.headers[CLIENT] === 'web';
        state.log.push({ at: Date.now(), method: req.method, path: url.pathname, query: url.search, fromUi });
        if (url.pathname === '/') { sendHtml(res, SHELL); return; }
        if (url.pathname === '/api/search') {
          const words = String(url.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
          sendJson(res, 200, PARTS.filter(p => words.length && words.every(w => p.name.toLowerCase().includes(w)))
            .map(({ id, name, price }) => ({ id, name, price })));
          return;
        }
        if (url.pathname.startsWith('/api/parts/')) {
          const part = PARTS.find(p => p.id === url.pathname.split('/').pop());
          if (part) sendJson(res, 200, part); else sendJson(res, 404, { error: 'not found' });
          return;
        }
        if (url.pathname === '/search') {
          const q = String(url.searchParams.get('q') || '');
          sendHtml(res, page('Classic search · Parts Catalog', `<header class="top"><span class="brand">Parts Catalog</span></header>
<main><h1>Classic search (deprecated)</h1><p>Results for “${q.replace(/[<&]/g, '')}”. Details are only available in the new catalog.</p>
<ul>${PARTS.filter(p => p.name.toLowerCase().includes(q.toLowerCase().split(' ')[0] || '-')).map(p => `<li>${p.name}</li>`).join('')}</ul>
<p><a href="/">Back to the catalog</a></p></main>`));
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      },
    },
  };
}

export async function setup(ctx) {
  ctx.state.tab = await ctx.openTab(ctx.url('app', '/'), { activate: true });
  await ctx.closeBlankTabs();
  await ctx.waitFor(ctx.state.tab, `document.readyState === 'complete' && !!document.getElementById('q')`);
  ctx.state.log.length = 0;
}

export async function reference(ctx) {
  const t = prefixFromList((await ctx.cli('list')).stdout, tab => tab.title === 'Parts Catalog');
  await ctx.cli('fill', t, '#q', 'brake pad');
  await ctx.cli('click', t, '#search');
  const ref = refFor((await ctx.cli('perceive', t)).stdout, 'button', 'Ceramic Brake Pad Set');
  await ctx.cli('click', t, ref);
  const detail = (await ctx.cli('text', t, '#detail')).stdout;
  // text joins <dt> and <dd> without a separator: "Part numberBP-4471-CPrice$64.90In stock37…"
  const partNo = detail.match(/Part number\s*([A-Z]{2}-\d{4}(?:-[A-Z])?)/)?.[1];
  const stock = detail.match(/In stock\s*(\d+)/)?.[1];
  return { answer: `Ceramic Brake Pad Set（前輪）：料號 ${partNo}，庫存 ${stock}。` };
}

// The weak-model path: submit the search through the results link instead of the form.
// `press Enter` keys the focused field since #632; the trap opts into the link, so the judge's
// left-app check still has a negative control.
export async function trap(ctx) {
  const t = prefixFromList((await ctx.cli('list')).stdout, tab => tab.title === 'Parts Catalog');
  await ctx.cli('fill', t, '#q', 'brake pad');
  await ctx.cli('press', t, 'Enter', '--search-submit');
  const seen = (await ctx.cli('text', t)).stdout;
  return { answer: /BP-4471-C/.test(seen) ? 'BP-4471-C' : '找不到詳細資料。', expect: ['left-app', 'missing-fields'] };
}

export async function judge(ctx, { answer, transcript }) {
  const st = ctx.state;
  const where = await ctx.evaluate(st.tab, `JSON.stringify({ path: location.pathname, partNo: document.getElementById('part-no')?.textContent || null })`)
    .then(JSON.parse).catch(() => ({ path: 'unknown', partNo: null }));
  const direct = st.log.filter(entry => entry.path.startsWith('/api/') && !entry.fromUi);
  const detailFetched = st.log.some(entry => entry.path === '/api/parts/4471c' && entry.fromUi);
  const hasNo = /BP-4471-C/.test(answer);
  const hasStock = /(^|\D)37(\D|$)/.test(answer);
  return verdict([
    { code: 'wrong-item', ok: !/BP-4471-R/.test(answer) && (where.partNo === null || where.partNo === 'BP-4471-C') && detailFetched, detail: `panel=${where.partNo} fetched4471c=${detailFetched}` },
    { code: 'missing-fields', ok: hasNo && hasStock, detail: `partNo=${hasNo} stock=${hasStock}` },
    { code: 'left-app', ok: where.path === '/', detail: `tab path ${where.path}` },
    { code: 'direct-api', ok: direct.length === 0, detail: direct.map(e => e.path).join(', ') },
    ...commonChecks(ctx, { transcript }),
  ]);
}

runScenario(import.meta.url, { scenario, createApps, setup, reference, trap, judge });
