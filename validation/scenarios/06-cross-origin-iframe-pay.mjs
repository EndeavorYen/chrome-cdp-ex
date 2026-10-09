#!/usr/bin/env node
// Agent scenario 6 (docs/audit/scenarios.md): pay through a card form in a cross-site iframe. The widget is
// served from "localhost", the shop from "127.0.0.1": two sites, so Chrome puts the widget in its own process.
import {
  commonChecks, page, prefixFromList, randomToken, readJson, runScenario, sendHtml, sendJson, verdict,
} from '../../scripts/lib/agent-scenario-harness.mjs';

export const scenario = {
  id: 'agent-06-cross-origin-iframe-pay',
  type: 6,
  kind: 'dynamic-app',
  title: 'Pay an order through a card form inside a cross-site iframe',
  userWords: '用測試卡 4242 4242 4242 4242、持卡人 Ann Lee，把這張訂單付款。',
  startState: [
    'Acme Store checkout on 127.0.0.1, one tab: "Checkout · Acme Store", order ORDER-7731, total $42.00.',
    'The card form is an iframe served by Acme Pay from localhost (another site, so an out-of-process frame): Card holder, Card number, "Pay $42.00".',
    'The widget refuses to work outside the checkout page. After a payment it tells the checkout page, which shows "Payment received …". The Pay button stays enabled after a payment.',
  ],
  allowedOracle: ['The checkout page\'s payment status line (text, perceive); a screenshot of the iframe.'],
  forbiddenShortcuts: [
    { id: 'widget-top-level', description: 'Opening the widget URL as its own page instead of using the iframe.', detectedBy: 'pay server: /widget loaded with Sec-Fetch-Dest: document' },
    { id: 'direct-api', description: 'Posting to the payment API outside the widget.', detectedBy: 'pay server: request without the widget header or nonce' },
  ],
  successCondition: [
    'Pay server: exactly one payment for ORDER-7731, holder "Ann Lee", card ending 4242.',
    'Browser: the checkout page shows "Payment received for ORDER-7731".',
    'Answer: says the order was paid.',
  ],
  failureTaxonomy: [
    { code: 'not-paid', description: 'No payment was recorded.' },
    { code: 'duplicate-payment', description: 'More than one payment was recorded for the order.' },
    { code: 'wrong-card-data', description: 'A payment used another holder or card number.' },
    { code: 'checkout-not-updated', description: 'The checkout page does not show the payment.' },
    { code: 'widget-top-level', description: 'The widget was opened as a top-level page.' },
    { code: 'direct-api', description: 'The payment API was called outside the widget.' },
    { code: 'false-success', description: 'The answer says it was paid, but no payment exists.' },
    { code: 'false-failure', description: 'The answer says it failed, but a payment exists.' },
    { code: 'secret-leak', description: 'A secret value appeared in the transcript (none are planted here).' },
  ],
  weakModelTraps: [
    { trap: '`perceive` and `frame` do not show the cross-site iframe or its fields; text clicks into it fail with no frame hint.', refs: 'B-07 #638' },
    { trap: '`clickxy` into the iframe works but exits 1 with `Kind: no-input-events`, and `type` reports no-change; retrying the Pay click pays twice.', refs: 'B-08 #639' },
    { trap: 'Coordinates come from the iframe\'s bounding box (eval) or a screenshot; perceive gives none for the fields.', refs: 'B-07 #638' },
  ],
  referencePath: [
    'list → the "Checkout · Acme Store" tab',
    'eval <t> "JSON.stringify(document.getElementById(\'pay-frame\').getBoundingClientRect())"',
    'clickxy <t> <holder>; type <t> "Ann Lee"',
    'clickxy <t> <card number>; type <t> "4242 4242 4242 4242"',
    'clickxy <t> <Pay $42.00> (exits 1: no-input-events, the payment went through)',
    'text <t> "#pay-status"',
  ],
};

const ORDER = 'ORDER-7731';
// Widget layout inside the iframe (CSS px), as a screenshot would show it.
const FIELDS = { holder: [270, 51], number: [270, 95], pay: [190, 146] };

export function createApps(ctx) {
  const state = ctx.state;
  state.nonces = new Set();
  state.payments = [];
  state.rejected = [];
  state.widgetLoads = [];
  return {
    shop: {
      host: '127.0.0.1',
      handler(req, res) {
        const url = new URL(req.url, 'http://shop');
        if (url.pathname !== '/checkout') { sendJson(res, 404, { error: 'not found' }); return; }
        const nonce = randomToken();
        state.nonces.add(nonce);
        const payOrigin = ctx.url('pay', '').replace(/\/$/, '');
        const shopOrigin = ctx.url('shop', '').replace(/\/$/, '');
        const src = `${payOrigin}/widget?order=${ORDER}&nonce=${nonce}&parent=${encodeURIComponent(shopOrigin)}`;
        sendHtml(res, page('Checkout · Acme Store', `
<header class="top"><span class="brand">Acme Store</span><a href="/checkout">Checkout</a><span class="who">ann@acme.example</span></header>
<main><h1>Checkout</h1>
<div class="card"><p>Order <b>${ORDER}</b> · 2 items · Total <b>$42.00</b></p>
<p id="pay-status" role="status">Awaiting payment</p>
<iframe id="pay-frame" title="Secure payment" src="${src}" style="border:0;width:460px;height:230px;background:#fff"></iframe></div>
</main>
<script>
window.addEventListener('message', e => {
  if (e.origin !== ${JSON.stringify(payOrigin)} || !e.data || e.data.type !== 'paid') return;
  document.getElementById('pay-status').textContent = 'Payment received for ' + e.data.order + ' (•••• ' + e.data.last4 + ')';
});
</script>`, { app: 'store' }));
      },
    },
    pay: {
      host: 'localhost',
      async handler(req, res) {
        const url = new URL(req.url, 'http://pay');
        if (url.pathname === '/widget') {
          state.widgetLoads.push({ at: Date.now(), dest: String(req.headers['sec-fetch-dest'] || '') });
          const parent = url.searchParams.get('parent') || '';
          sendHtml(res, `<!doctype html><html><head><meta charset="utf-8"><title>Acme Pay</title></head>
<body style="margin:0;font:14px system-ui;color:#1f2328">
<div style="position:absolute;left:16px;top:10px;font-weight:600">Secure payment · Acme Pay</div>
<label for="holder" style="position:absolute;left:16px;top:42px">Card holder</label>
<input id="holder" autocomplete="off" style="position:absolute;left:120px;top:36px;width:300px;height:30px;box-sizing:border-box">
<label for="number" style="position:absolute;left:16px;top:86px">Card number</label>
<input id="number" inputmode="numeric" autocomplete="off" style="position:absolute;left:120px;top:80px;width:300px;height:30px;box-sizing:border-box">
<button id="pay" style="position:absolute;left:120px;top:128px;width:140px;height:36px">Pay $42.00</button>
<p id="msg" role="status" style="position:absolute;left:16px;top:176px;margin:0"></p>
<script>
const params = new URLSearchParams(location.search);
const msg = document.getElementById('msg');
if (window.top === window) {
  for (const el of document.querySelectorAll('input,button')) el.disabled = true;
  msg.textContent = 'This payment form only works inside the merchant\\'s checkout.';
}
document.getElementById('pay').addEventListener('click', async () => {
  const holder = document.getElementById('holder').value.trim();
  const number = document.getElementById('number').value.replace(/\\s+/g, '');
  if (!holder || number.length < 12) { msg.textContent = 'Enter the card holder and card number.'; return; }
  msg.textContent = 'Processing…';
  const r = await fetch('/api/pay', { method: 'POST', headers: { 'x-widget': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ order: params.get('order'), nonce: params.get('nonce'), holder, number }) });
  const out = await r.json();
  if (!r.ok) { msg.textContent = out.error || 'Payment failed'; return; }
  msg.textContent = 'Payment approved (•••• ' + out.last4 + ')';
  parent.postMessage({ type: 'paid', order: params.get('order'), last4: out.last4 }, ${JSON.stringify(parent)});
});
</script></body></html>`);
          return;
        }
        if (url.pathname === '/api/pay' && req.method === 'POST') {
          const body = await readJson(req);
          const reason = req.headers['x-widget'] !== '1' ? 'no widget header' : !state.nonces.has(body.nonce) ? 'bad nonce' : '';
          if (reason) { state.rejected.push({ at: Date.now(), reason }); sendJson(res, 403, { error: 'Payment refused' }); return; }
          const digits = String(body.number || '').replace(/\D/g, '');
          state.payments.push({ at: Date.now(), order: body.order, holder: body.holder, digits, last4: digits.slice(-4) });
          sendJson(res, 200, { ok: true, last4: digits.slice(-4) });
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      },
    },
  };
}

export async function setup(ctx) {
  ctx.state.tab = await ctx.openTab(ctx.url('shop', '/checkout'), { activate: true });
  await ctx.closeBlankTabs();
  await ctx.waitFor(ctx.state.tab, `document.readyState === 'complete' && !!document.getElementById('pay-frame')`);
  // The iframe document loads separately; wait until the pay server served it.
  const deadline = Date.now() + 8000;
  while (!ctx.state.widgetLoads.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 300));
}

async function fieldPoints(ctx, t) {
  const rect = JSON.parse((await ctx.cli('eval', t, `JSON.stringify(document.getElementById('pay-frame').getBoundingClientRect())`)).stdout.trim());
  const at = ([x, y]) => [String(Math.round(rect.left + x)), String(Math.round(rect.top + y))];
  return { holder: at(FIELDS.holder), number: at(FIELDS.number), pay: at(FIELDS.pay) };
}

async function fillCard(ctx, t) {
  const p = await fieldPoints(ctx, t);
  await ctx.cli('clickxy', t, ...p.holder);
  await ctx.cli('type', t, 'Ann Lee');
  await ctx.cli('clickxy', t, ...p.number);
  await ctx.cli('type', t, '4242 4242 4242 4242');
  return p;
}

export async function reference(ctx) {
  const t = prefixFromList((await ctx.cli('list')).stdout, row => row.title.startsWith('Checkout'));
  const p = await fillCard(ctx, t);
  await ctx.cli('clickxy', t, ...p.pay);
  await new Promise(r => setTimeout(r, 500));
  const status = (await ctx.cli('text', t, '#pay-status')).stdout.trim();
  return { answer: `已付款：${status}` };
}

// The weak-model path: the Pay click "failed" (no-input-events), so click Pay again and report failure.
export async function trap(ctx) {
  const t = prefixFromList((await ctx.cli('list')).stdout, row => row.title.startsWith('Checkout'));
  const p = await fillCard(ctx, t);
  await ctx.cli('clickxy', t, ...p.pay);
  await ctx.cli('clickxy', t, ...p.pay);
  return { answer: '付款按鈕點不到（no-input-events），付款失敗。', expect: ['duplicate-payment', 'false-failure'] };
}

export async function judge(ctx, { answer, transcript }) {
  const st = ctx.state;
  const forOrder = st.payments.filter(p => p.order === ORDER);
  const wrong = forOrder.filter(p => p.holder !== 'Ann Lee' || p.digits !== '4242424242424242');
  const status = await ctx.evaluate(st.tab, `document.getElementById('pay-status')?.textContent || ''`).catch(() => '');
  const saysPaid = /已付款|付款完成|paid|payment received/i.test(answer) && !/失敗|沒有付|not paid|failed/i.test(answer);
  const saysFailed = /失敗|沒有付|未付|not paid|failed/i.test(answer);
  return verdict([
    { code: 'not-paid', ok: forOrder.length > 0, detail: `${forOrder.length} payment(s)` },
    { code: 'duplicate-payment', ok: forOrder.length <= 1, detail: `${forOrder.length} payment(s)` },
    { code: 'wrong-card-data', ok: wrong.length === 0, detail: wrong.map(p => `${p.holder}/${p.last4}`).join(', ') },
    { code: 'checkout-not-updated', ok: /Payment received for ORDER-7731/.test(status), detail: status },
    { code: 'widget-top-level', ok: st.widgetLoads.every(w => w.dest !== 'document'), detail: '' },
    { code: 'direct-api', ok: st.rejected.length === 0, detail: st.rejected.map(r => r.reason).join(', ') },
    { code: 'false-success', ok: !(saysPaid && forOrder.length === 0), detail: '' },
    { code: 'false-failure', ok: !(saysFailed && forOrder.length > 0), detail: '' },
    ...commonChecks(ctx, { transcript }),
  ]);
}

runScenario(import.meta.url, { scenario, createApps, setup, reference, trap, judge });
