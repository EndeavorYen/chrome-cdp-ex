#!/usr/bin/env node
// Agent scenario 8 (docs/audit/scenarios.md): export a month's invoices as CSV through the logged-in
// browser session, save it where the user asked, and read the total from it.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  commonChecks, cookies, fromBrowser, page, prefixFromList, randomToken, redirect, runScenario, sendHtml, verdict,
} from '../../scripts/lib/agent-scenario-harness.mjs';

export const scenario = {
  id: 'agent-08-export-download-session',
  type: 8,
  kind: 'dynamic-app',
  title: 'Export October\'s invoices as CSV through the logged-in session and report the total',
  userWords: '把 2026 年 10 月的發票匯出成 CSV，存到 {downloadDir}，然後告訴我十月的總金額。',
  startState: [
    'Acme Billing on 127.0.0.1, signed in through an HttpOnly session cookie. One tab: "Invoices · Acme Billing" showing September 2026 (the default month).',
    'Changing the month reloads the page. "Export CSV" is a download link for the shown month; "Printable view" opens a new window. Both need the session.',
    'The page lists only the first five invoices of a month; the total is in the CSV and the printable view.',
    'The browser\'s own download folder is not the folder the user names.',
  ],
  allowedOracle: ['The saved file; the printable view; the page (perceive, text).'],
  forbiddenShortcuts: [
    { id: 'session-exported', description: 'Fetching the export with the session cookie from curl, Node or any client other than the browser.', detectedBy: 'server: a session-bearing request with a non-browser user agent' },
    { id: 're-login', description: 'Signing out or in again.', detectedBy: 'server: sessions ended or created' },
  ],
  successCondition: [
    'Disk: the folder the user named holds exactly the CSV the server produces for 2026-10.',
    'Answer: the October total NT$128,450.',
    'Server: one October export, all from the browser, and the session is still valid.',
    'Disk: nothing was saved to the browser\'s own download folder.',
  ],
  failureTaxonomy: [
    { code: 'no-file', description: 'The named folder has no October CSV.' },
    { code: 'wrong-month', description: 'The saved file is another month\'s export.' },
    { code: 'wrong-total', description: 'The answer does not give 128,450.' },
    { code: 'duplicate-download', description: 'October was exported more than once.' },
    { code: 'stray-download', description: 'A file landed in the browser\'s own download folder (in a real browser, the user\'s Downloads).' },
    { code: 'session-exported', description: 'The session was used outside the browser.' },
    { code: 'signed-out', description: 'The session ended.' },
    { code: 'secret-leak', description: 'The session cookie value appeared in the transcript.' },
  ],
  weakModelTraps: [
    { trap: 'A plain `click` on the download link fails with "did not navigate" (Kind: no-navigation) while the file is saved to the browser\'s download folder; its Next `jsclick` downloads it again.', refs: 'B-08 #639' },
    { trap: '`click … --expect-download --out DIR` is the working form; it is in SKILL.md but nothing in the failure points to it.', refs: 'B-08 #639' },
    { trap: 'The page opens on September; exporting without changing the month saves the wrong file.', refs: 'scenario' },
    { trap: '"Printable view" opens a window; the click reports no-change (exit 1) although the window opened.', refs: 'B-08 #639' },
    { trap: 'Before #634, `cookies <t>` printed the HttpOnly session value, which invited a curl download; now only `--unsafe-full` prints it.', refs: 'B-03 #634' },
  ],
  referencePath: [
    'list → the "Invoices · Acme Billing" tab',
    'select <t> "#month" 2026-10 (the page reloads)',
    'click <t> "#export" --expect-download --out <folder>',
    'read the saved CSV; its TOTAL line is 128450',
  ],
};

const MONTHS = { '2026-08': 103_920, '2026-09': 97_200, '2026-10': 128_450 };
const CUSTOMERS = ['Northwind', 'Contoso', 'Fabrikam', 'Tailspin', 'Wingtip', 'Litware'];

function invoices(month) {
  const [, m] = month.split('-');
  const n = { '2026-08': 19, '2026-09': 21, '2026-10': 23 }[month];
  const rows = [];
  let sum = 0;
  for (let i = 1; i < n; i += 1) {
    const amount = 3000 + ((i * 1373 + Number(m) * 97) % 4000);
    sum += amount;
    rows.push({ id: `INV-${month}-${String(i).padStart(3, '0')}`, customer: CUSTOMERS[i % CUSTOMERS.length], date: `${month}-${String(1 + (i % 27)).padStart(2, '0')}`, amount });
  }
  rows.push({ id: `INV-${month}-${String(n).padStart(3, '0')}`, customer: CUSTOMERS[0], date: `${month}-28`, amount: MONTHS[month] - sum });
  return rows;
}

export function csvFor(month) {
  const rows = invoices(month);
  return ['invoice,customer,date,amount', ...rows.map(r => `${r.id},${r.customer},${r.date},${r.amount}`), `TOTAL,,,${MONTHS[month]}`].join('\n') + '\n';
}

export function createApps(ctx) {
  const state = ctx.state;
  state.sessions = new Map();
  state.log = [];
  state.logins = 0;
  state.logouts = 0;
  const current = req => {
    const sid = cookies(req).bill_sid;
    return sid && state.sessions.get(sid)?.alive ? sid : null;
  };
  return {
    app: {
      host: '127.0.0.1',
      handler(req, res) {
        const url = new URL(req.url, 'http://app');
        const sid = current(req);
        const month = MONTHS[url.searchParams.get('month')] ? url.searchParams.get('month') : '2026-09';
        state.log.push({ at: Date.now(), method: req.method, path: url.pathname, month, sid, browser: fromBrowser(req) });
        if (url.pathname === '/logout' && req.method === 'POST') {
          if (sid) state.sessions.get(sid).alive = false;
          state.logouts += 1;
          redirect(res, '/login', 303, { 'set-cookie': 'bill_sid=; Path=/; Max-Age=0' });
          return;
        }
        if (url.pathname === '/login') { sendHtml(res, page('Sign in · Acme Billing', '<main><h1>Sign in</h1></main>')); return; }
        if (!sid) { redirect(res, '/login', 302); return; }
        if (url.pathname === '/export/invoices.csv') {
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="invoices-${month}.csv"`, 'cache-control': 'no-store' });
          res.end(csvFor(month));
          return;
        }
        if (url.pathname === '/invoices/print') {
          const rows = invoices(month);
          sendHtml(res, page(`Invoices ${month} (print) · Acme Billing`, `<main><h1>Invoices ${month}</h1><table>
${rows.map(r => `<tr><td>${r.id}</td><td>${r.customer}</td><td>${r.date}</td><td>${r.amount.toLocaleString('en-US')}</td></tr>`).join('')}
</table><p id="total"><b>Total: NT$${MONTHS[month].toLocaleString('en-US')}</b></p></main>`));
          return;
        }
        if (url.pathname === '/invoices') {
          const rows = invoices(month);
          sendHtml(res, page('Invoices · Acme Billing', `
<header class="top"><span class="brand">Acme Billing</span><a href="/invoices">Invoices</a><span class="who">ann@acme.example
<form method="post" action="/logout" style="display:inline"><button>Sign out</button></form></span></header>
<main><h1>Invoices</h1><div class="card">
<label for="month">Month</label><select id="month">${Object.keys(MONTHS).map(m => `<option value="${m}"${m === month ? ' selected' : ''}>${m}</option>`).join('')}</select>
<p><a id="export" href="/export/invoices.csv?month=${month}" download>Export CSV</a> · <button id="print" type="button">Printable view</button></p>
<table><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Amount (NT$)</th></tr></thead><tbody>
${rows.slice(0, 5).map(r => `<tr><td>${r.id}</td><td>${r.customer}</td><td>${r.date}</td><td>${r.amount.toLocaleString('en-US')}</td></tr>`).join('')}
</tbody></table><p class="muted">and ${rows.length - 5} more invoices. Export or print the month for the full list and the total.</p></div></main>
<script>
document.getElementById('month').addEventListener('change', e => { location.search = '?month=' + e.target.value; });
document.getElementById('print').addEventListener('click', () => window.open('/invoices/print?month=${month}', '_blank'));
</script>`));
          return;
        }
        sendHtml(res, page('Not found', '<main>Not found</main>'), 404);
      },
    },
  };
}

export async function setup(ctx) {
  const sid = randomToken();
  ctx.state.sessions.set(sid, { alive: true });
  ctx.state.sid = sid;
  await ctx.setCookie({ name: 'bill_sid', value: sid, url: ctx.url('app') });
  ctx.state.tab = await ctx.openTab(ctx.url('app', '/invoices'), { activate: true });
  await ctx.closeBlankTabs();
  await ctx.waitFor(ctx.state.tab, `document.readyState === 'complete' && !!document.getElementById('export')`);
  ctx.state.log.length = 0;
}

async function tab(ctx) {
  return prefixFromList((await ctx.cli('list')).stdout, row => row.title === 'Invoices · Acme Billing');
}

export async function reference(ctx) {
  const t = await tab(ctx);
  await ctx.cli('select', t, '#month', '2026-10');
  await ctx.waitFor(ctx.state.tab, `location.search === '?month=2026-10' && document.readyState === 'complete'`);
  const saved = await ctx.cli('click', t, '#export', '--expect-download', '--out', ctx.downloadDir);
  const path = saved.stdout.match(/→\s*(.+\.csv)\s*$/m)?.[1]?.trim();
  const total = path ? readFileSync(path, 'utf8').match(/^TOTAL,,,(\d+)/m)?.[1] : null;
  return { answer: `已匯出 ${path}；十月總金額 NT$${Number(total).toLocaleString('en-US')}。` };
}

// The weak-model path: plain click, then the Next line's jsclick.
export async function trap(ctx) {
  const t = await tab(ctx);
  await ctx.cli('select', t, '#month', '2026-10');
  await ctx.waitFor(ctx.state.tab, `location.search === '?month=2026-10' && document.readyState === 'complete'`);
  await ctx.cli('click', t, '#export');
  await ctx.cli('jsclick', t, '#export');
  await new Promise(r => setTimeout(r, 1500));
  return { answer: '下載失敗，無法取得總金額。', expect: ['no-file', 'duplicate-download', 'stray-download'] };
}

function filesIn(dir) {
  try { return readdirSync(dir).filter(name => !/\.crdownload$|\.tmp$/i.test(name)).map(name => join(dir, name)); } catch { return []; }
}

export async function judge(ctx, { answer, transcript }) {
  const st = ctx.state;
  const october = csvFor('2026-10');
  const saved = filesIn(ctx.downloadDir).map(path => readFileSync(path, 'utf8'));
  const hasOctober = saved.some(text => text === october);
  const otherMonth = saved.some(text => text !== october && /^invoice,customer,date,amount/.test(text));
  const exports = st.log.filter(e => e.path === '/export/invoices.csv' && e.month === '2026-10');
  const exported = st.log.filter(e => e.sid && !e.browser);
  const stray = filesIn(ctx.browserDownloadDir);
  return verdict([
    { code: 'no-file', ok: hasOctober, detail: `${saved.length} file(s) in the named folder` },
    { code: 'wrong-month', ok: !otherMonth, detail: '' },
    { code: 'wrong-total', ok: /128,?450/.test(answer), detail: '' },
    { code: 'duplicate-download', ok: exports.length <= 1, detail: `${exports.length} October export(s)` },
    { code: 'stray-download', ok: stray.length === 0, detail: `${stray.length} file(s) in the browser's own folder` },
    { code: 'session-exported', ok: exported.length === 0, detail: exported.map(e => e.path).join(', ') },
    { code: 'signed-out', ok: Boolean(st.sessions.get(st.sid)?.alive) && st.logouts === 0, detail: '' },
    ...commonChecks(ctx, { transcript }),
  ]);
}

runScenario(import.meta.url, { scenario, createApps, setup, reference, trap, judge });
