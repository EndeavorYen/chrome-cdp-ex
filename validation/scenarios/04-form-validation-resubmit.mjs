#!/usr/bin/env node
// Agent scenario 4 (docs/audit/scenarios.md): submit a form, read the server's validation error, fix the
// one field, and resubmit exactly once.
import {
  commonChecks, page, prefixFromList, readJson, refFor, runScenario, sendHtml, sendJson, verdict,
} from '../../scripts/lib/agent-scenario-harness.mjs';

export const scenario = {
  id: 'agent-04-form-validation-resubmit',
  type: 4,
  kind: 'dynamic-app',
  title: 'Create a vendor: fix the field the server rejects and resubmit',
  userWords: '新增一家供應商：公司名稱 Lumen Tech、統編 2468-1357、聯絡信箱 ap@lumen.example，付款條件不用改。送出後如果有錯，修正後再送一次。',
  startState: [
    'Acme Procurement on 127.0.0.1, one tab: "New vendor · Acme Procurement". Fields: Company name, Tax ID, Contact email, Payment terms (Net 30).',
    'The server validates on submit: the Tax ID must be 8 digits without dashes (HTTP 422 with a field error). After a success the form clears; a second vendor with the same Tax ID is refused (HTTP 409).',
  ],
  allowedOracle: ['The error summary, the field error, and the confirmation banner (perceive, text).'],
  forbiddenShortcuts: [
    { id: 'direct-api', description: 'Posting the vendor to /api/vendors outside the form.', detectedBy: 'server: request without the form\'s client header' },
  ],
  successCondition: [
    'Server: exactly one vendor exists: name "Lumen Tech", Tax ID 24681357, email ap@lumen.example, terms net30.',
    'Server: no request was refused as a duplicate (409).',
  ],
  failureTaxonomy: [
    { code: 'not-created', description: 'No vendor was created.' },
    { code: 'wrong-value', description: 'The vendor was created with different data (dash kept, quotes, another email, other terms).' },
    { code: 'duplicate-submit', description: 'The form was submitted again after success (409), or two vendors exist.' },
    { code: 'direct-api', description: 'The vendor was posted outside the form.' },
    { code: 'false-success', description: 'The answer says it was created, but it was not.' },
    { code: 'secret-leak', description: 'A secret value appeared in the transcript (none are planted here).' },
  ],
  weakModelTraps: [
    { trap: 'After the 422, `perceive --since-action` shows the new error text only as "Text nodes updated"; the message itself needs text or a full perceive.', refs: 'T-08' },
    { trap: '`click <t> "Create vendor"` is read as a CSS selector.', refs: 'B-10 #641' },
    { trap: 'The click receipt is a one-line "Clicked …" in both the 422 and the 201 case.', refs: 'T-07' },
    { trap: 'Resubmitting after success, or retrying an unchanged form, produces 409 or another 422.', refs: 'scenario' },
  ],
  referencePath: [
    'list → the "New vendor" tab',
    'fill <t> "#name" "Lumen Tech"; fill <t> "#taxId" "2468-1357"; fill <t> "#email" "ap@lumen.example"',
    'perceive <t> → @ref of "Create vendor"; click <t> @ref',
    'text <t> "#taxId-error"',
    'fill <t> "#taxId" "24681357"; click <t> "#create"',
    'text <t> "#flash"',
  ],
};

const CLIENT = 'x-vendor-client';

const FORM = page('New vendor · Acme Procurement', `
<header class="top"><span class="brand">Acme Procurement</span><a href="/vendors">Vendors</a><span class="who">buyer@acme.example</span></header>
<main><h1>New vendor</h1>
<div id="flash" role="status"></div>
<div id="errors" role="alert"></div>
<form id="vendor" class="card" novalidate>
<label for="name">Company name</label><input id="name" name="name" autocomplete="off">
<label for="taxId">Tax ID</label><input id="taxId" name="taxId" aria-describedby="taxId-error" autocomplete="off"><p id="taxId-error" class="error"></p>
<label for="email">Contact email</label><input id="email" name="email" type="email" aria-describedby="email-error"><p id="email-error" class="error"></p>
<label for="terms">Payment terms</label><select id="terms" name="terms"><option value="net30" selected>Net 30</option><option value="net45">Net 45</option><option value="net60">Net 60</option></select>
<p><button id="create" class="primary" type="submit">Create vendor</button></p>
</form></main>
<script>
const form = document.getElementById('vendor');
const fields = ['name', 'taxId', 'email'];
form.addEventListener('submit', async e => {
  e.preventDefault();
  for (const f of fields) { document.getElementById(f).removeAttribute('aria-invalid'); const err = document.getElementById(f + '-error'); if (err) err.textContent = ''; }
  document.getElementById('errors').textContent = '';
  document.getElementById('flash').className = ''; document.getElementById('flash').textContent = '';
  const body = Object.fromEntries(new FormData(form));
  const r = await fetch('/api/vendors', { method: 'POST', headers: { '${CLIENT}': 'web', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await r.json();
  if (r.ok) {
    form.reset();
    document.getElementById('flash').className = 'flash ok';
    document.getElementById('flash').textContent = 'Vendor “' + out.name + '” created (' + out.id + ').';
    return;
  }
  const errors = out.errors || {};
  document.getElementById('errors').className = 'flash err';
  document.getElementById('errors').textContent = 'There ' + (Object.keys(errors).length === 1 ? 'is 1 problem' : 'are ' + Object.keys(errors).length + ' problems') + ' with this form.';
  for (const [f, msg] of Object.entries(errors)) {
    document.getElementById(f).setAttribute('aria-invalid', 'true');
    const err = document.getElementById(f + '-error'); if (err) err.textContent = msg;
  }
});
</script>`);

export function createApps(ctx) {
  const state = ctx.state;
  state.vendors = [];
  state.attempts = [];
  return {
    app: {
      host: '127.0.0.1',
      async handler(req, res) {
        const url = new URL(req.url, 'http://app');
        if (url.pathname === '/vendors/new') { sendHtml(res, FORM); return; }
        if (url.pathname === '/api/vendors' && req.method === 'POST') {
          const body = await readJson(req);
          const fromUi = req.headers[CLIENT] === 'web';
          const errors = {};
          if (!String(body.name || '').trim()) errors.name = 'Company name is required.';
          if (!/^\d{8}$/.test(String(body.taxId || ''))) errors.taxId = 'Tax ID must be exactly 8 digits, without dashes or spaces.';
          if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(body.email || ''))) errors.email = 'Enter a valid email address.';
          let status = 201;
          if (Object.keys(errors).length) status = 422;
          else if (state.vendors.some(v => v.taxId === body.taxId)) { status = 409; errors.taxId = 'A vendor with this Tax ID already exists.'; }
          state.attempts.push({ at: Date.now(), status, fromUi, body });
          if (status !== 201) { sendJson(res, status, { errors }); return; }
          const vendor = { id: `V-${1007 + state.vendors.length}`, name: body.name, taxId: body.taxId, email: body.email, terms: body.terms, fromUi };
          state.vendors.push(vendor);
          sendJson(res, 201, vendor);
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      },
    },
  };
}

export async function setup(ctx) {
  ctx.state.tab = await ctx.openTab(ctx.url('app', '/vendors/new'), { activate: true });
  await ctx.closeBlankTabs();
  await ctx.waitFor(ctx.state.tab, `document.readyState === 'complete' && !!document.getElementById('create')`);
}

async function tab(ctx) {
  return prefixFromList((await ctx.cli('list')).stdout, row => row.title.startsWith('New vendor'));
}

export async function reference(ctx) {
  const t = await tab(ctx);
  await ctx.cli('fill', t, '#name', 'Lumen Tech');
  await ctx.cli('fill', t, '#taxId', '2468-1357');
  await ctx.cli('fill', t, '#email', 'ap@lumen.example');
  await ctx.cli('click', t, refFor((await ctx.cli('perceive', t)).stdout, 'button', 'Create vendor'));
  const error = (await ctx.cli('text', t, '#taxId-error')).stdout.trim();
  await ctx.cli('fill', t, '#taxId', '24681357');
  await ctx.cli('click', t, '#create');
  const flash = (await ctx.cli('text', t, '#flash')).stdout.trim();
  return { answer: `第一次送出被拒（${error}），把統編改成 24681357 後重送成功：${flash}` };
}

// The weak-model path: submit, never read the error, and report success.
export async function trap(ctx) {
  const t = await tab(ctx);
  await ctx.cli('fill', t, '#name', 'Lumen Tech');
  await ctx.cli('fill', t, '#taxId', '2468-1357');
  await ctx.cli('fill', t, '#email', 'ap@lumen.example');
  await ctx.cli('click', t, '#create');
  await ctx.cli('perceive', t, '--since-action');
  return { answer: '已建立供應商 Lumen Tech。', expect: ['not-created', 'false-success'] };
}

export async function judge(ctx, { answer, transcript }) {
  const st = ctx.state;
  const lumen = st.vendors.filter(v => /lumen/i.test(v.name));
  const exact = lumen.filter(v => v.name === 'Lumen Tech' && v.taxId === '24681357' && v.email === 'ap@lumen.example' && v.terms === 'net30');
  const conflicts = st.attempts.filter(a => a.status === 409);
  const claims = /created|已建立|新增成功|建立成功|成功/i.test(answer) && !/失敗|沒有成功|not created/i.test(answer);
  return verdict([
    { code: 'not-created', ok: lumen.length > 0, detail: `${st.vendors.length} vendor(s)` },
    { code: 'wrong-value', ok: lumen.length === 0 || exact.length === lumen.length, detail: JSON.stringify(lumen.map(({ name, taxId, email, terms }) => ({ name, taxId, email, terms }))) },
    { code: 'duplicate-submit', ok: conflicts.length === 0 && lumen.length <= 1, detail: `${conflicts.length} conflict(s)` },
    { code: 'direct-api', ok: st.attempts.every(a => a.fromUi), detail: '' },
    { code: 'false-success', ok: !(claims && exact.length === 0), detail: '' },
    ...commonChecks(ctx, { transcript }),
  ]);
}

runScenario(import.meta.url, { scenario, createApps, setup, reference, trap, judge });
