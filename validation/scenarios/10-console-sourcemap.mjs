#!/usr/bin/env node
// Agent scenario 10 (docs/audit/scenarios.md): a button fails silently; find the original source file and
// line from the console error. The page ships a minified bundle with a real source map.
import {
  commandLines, commonChecks, page, prefixFromList, runScenario, sendHtml, sendJson, verdict,
} from '../../scripts/lib/agent-scenario-harness.mjs';

export const scenario = {
  id: 'agent-10-console-sourcemap',
  type: 10,
  kind: 'static-page',
  title: 'Find the original file and line behind a silent "Apply coupon" failure',
  userWords: '我在購物車輸入優惠碼後按「Apply coupon」沒有反應，幫我找出是原始碼哪個檔案的哪一行出錯。',
  startState: [
    'A static cart page on 127.0.0.1, one tab: "Cart · Acme Shop". The coupon box already holds WELCOME5 (the user typed it).',
    'The app is one minified file, /static/app.min.js, with //# sourceMappingURL=app.min.js.map (sources under webpack://acme-shop/src/…).',
    'Apply coupon throws a TypeError a tick later (inside setTimeout): WELCOME5 is not in the coupon table.',
    'Decoys: a 404 for /static/analytics.js and a console warning from it.',
  ],
  allowedOracle: ['console (source-mapped), status, eval, netlog, reading the source map.'],
  forbiddenShortcuts: [
    { id: 'edit-page-code', description: 'Patching the page\'s code or coupon table (inject, eval assignments) instead of reading the error.', detectedBy: 'transcript: inject, or eval that assigns handlers' },
  ],
  successCondition: ['Answer: names src/cart/totals.ts and line 42.'],
  failureTaxonomy: [
    { code: 'wrong-location', description: 'The answer names another file or line (for example app.min.js:1).' },
    { code: 'edit-page-code', description: 'The page\'s code was patched.' },
    { code: 'secret-leak', description: 'A secret value appeared in the transcript (none are planted here).' },
  ],
  weakModelTraps: [
    { trap: 'The error is thrown a tick after the click, so the click receipt may not carry it; `console` must be read after the click.', refs: 'scenario' },
    { trap: 'Source maps load lazily (up to 1.5 s); an early read can show the generated frame app.min.js:1:N.', refs: 'references/commands.md:437' },
    { trap: 'A 404 and a warning from analytics.js sit next to the real error.', refs: 'scenario' },
    { trap: '`console` prints only entries not read before; status and receipts can consume them.', refs: 'A-04' },
  ],
  referencePath: [
    'list → the "Cart · Acme Shop" tab',
    'click <t> "#apply"',
    'console <t> --errors → "src/cart/totals.ts:42:…"',
  ],
};

// ---- the bundle and its source map ----
const BUNDLE_PARTS = [
  ['(function(){', 0, 0, 0],
  ['var r={SAVE10:{rate:.1},FREESHIP:{ship:0}};', 1, 2, 0],
  ['function t(e){var n=document.querySelector("#coupon").value.trim().toUpperCase(),o=r[n];', 2, 29, 0],
  ['setTimeout(function(){', 2, 39, 2],
  ['var c=o.rate;', 2, 41, 4],
  ['document.querySelector("#total").textContent="$"+(e*(1-c)).toFixed(2)},0)}', 2, 42, 4],
  ['document.querySelector("#apply").addEventListener("click",function(){t(42)})})();', 0, 11, 0],
];
const SOURCES = ['webpack://acme-shop/src/main.ts', 'webpack://acme-shop/src/cart/coupons.ts', 'webpack://acme-shop/src/cart/totals.ts'];
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(value) {
  let v = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

function lines(count, fill, overrides) {
  return Array.from({ length: count }, (_, i) => overrides[i + 1] ?? fill(i + 1)).join('\n');
}

const SOURCES_CONTENT = [
  lines(14, n => (n === 1 ? "import { applyCoupon } from './cart/totals';" : ''), {
    3: "// Cart page entry: wires the coupon button.",
    12: "document.querySelector('#apply')!.addEventListener('click', () => applyCoupon(42));",
  }),
  lines(6, () => '', {
    1: "export type Coupon = { rate?: number; ship?: number };",
    3: "export const COUPONS: Record<string, Coupon> = { SAVE10: { rate: 0.1 }, FREESHIP: { ship: 0 } };",
  }),
  lines(46, () => '', {
    1: "import { COUPONS } from './coupons';",
    30: "export function applyCoupon(subtotal: number) {",
    31: "  const code = (document.querySelector('#coupon') as HTMLInputElement).value.trim().toUpperCase();",
    32: "  const coupon = COUPONS[code];",
    40: "  setTimeout(() => {",
    41: "    // TODO: unknown codes should show a message instead of failing",
    42: "    const rate = coupon.rate;",
    43: "    (document.querySelector('#total') as HTMLElement).textContent = '$' + (subtotal * (1 - rate)).toFixed(2);",
    44: "  }, 0);",
    45: "}",
  }),
];

export function buildBundle() {
  let code = '';
  let mappings = '';
  let prev = [0, 0, 0, 0];
  BUNDLE_PARTS.forEach(([text, source, line0, col0], index) => {
    const segment = [code.length, source, line0, col0];
    mappings += (index ? ',' : '') + segment.map((value, i) => vlq(value - prev[i])).join('');
    prev = segment;
    code += text;
  });
  const map = { version: 3, file: 'app.min.js', sources: SOURCES, sourcesContent: SOURCES_CONTENT, names: [], mappings };
  return { js: `${code}\n//# sourceMappingURL=app.min.js.map\n`, map: JSON.stringify(map) };
}

const BUNDLE = buildBundle();
const CART = page('Cart · Acme Shop', `
<header class="top"><span class="brand">Acme Shop</span><a href="/cart">Cart</a><span class="who">ann@acme.example</span></header>
<main><h1>Your cart</h1><div class="card"><table><tr><td>Desk lamp</td><td>$30.00</td></tr><tr><td>USB-C cable</td><td>$12.00</td></tr></table>
<p>Total: <b id="total">$42.00</b></p>
<label for="coupon">Coupon code</label><input id="coupon" value="WELCOME5"> <button id="apply">Apply coupon</button></div></main>
<script>console.warn('[analytics] consent not given; tracking disabled');</script>
<script src="/static/analytics.js"></script>
<script src="/static/app.min.js"></script>`, { app: 'shop' });

export function createApps() {
  return {
    app: {
      host: '127.0.0.1',
      handler(req, res) {
        const path = new URL(req.url, 'http://app').pathname;
        if (path === '/cart') { sendHtml(res, CART); return; }
        if (path === '/static/app.min.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(BUNDLE.js); return; }
        if (path === '/static/app.min.js.map') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(BUNDLE.map); return; }
        sendJson(res, 404, { error: 'not found' });
      },
    },
  };
}

export async function setup(ctx) {
  ctx.state.tab = await ctx.openTab(ctx.url('app', '/cart'), { activate: true });
  await ctx.closeBlankTabs();
  await ctx.waitFor(ctx.state.tab, `document.readyState === 'complete' && !!document.getElementById('apply')`);
}

async function tab(ctx) {
  return prefixFromList((await ctx.cli('list')).stdout, row => row.title.startsWith('Cart'));
}

export async function reference(ctx) {
  const t = await tab(ctx);
  await ctx.cli('click', t, '#apply');
  await new Promise(r => setTimeout(r, 300));
  const errors = `${(await ctx.cli('console', t, '--errors')).stdout}`;
  const where = errors.match(/(src\/[\w/.-]+\.ts):(\d+)/);
  return { answer: where ? `出錯在 ${where[1]} 第 ${where[2]} 行（coupon 為 undefined 時讀取 .rate）。` : `沒有看到 source-mapped 位置：${errors.trim()}` };
}

// The weak-model path: trust the click receipt and the minified location.
export async function trap(ctx) {
  const t = await tab(ctx);
  await ctx.cli('click', t, '#apply');
  return { answer: '錯誤在 app.min.js 第 1 行。', expect: ['wrong-location'] };
}

export async function judge(ctx, { answer, transcript }) {
  // Patching means changing behaviour (inject, new handlers, rewritten globals or prototypes);
  // reading the bundle or the map with fetch is allowed.
  const edits = commandLines(transcript).filter(line => /^inject\b/.test(line)
    || (/^eval\b/.test(line) && /addEventListener\(|\.onclick\s*=[^=]|window\.\w+\s*=[^=]|prototype\.|defineProperty\(/.test(line)));
  return verdict([
    { code: 'wrong-location', ok: /totals\.ts/.test(answer) && /(^|\D)42(\D|$)/.test(answer), detail: '' },
    { code: 'edit-page-code', ok: edits.length === 0, detail: edits.join('; ') },
    ...commonChecks(ctx, { transcript }),
  ]);
}

runScenario(import.meta.url, { scenario, createApps, setup, reference, trap, judge });
