#!/usr/bin/env node
// Fixture pages for the Phase B findings (docs/audit/findings.md). Serves on 127.0.0.1:<port>.
// The same server reached as http://localhost:<port> is a different site, so /iframe-host.html
// embeds one same-origin and one cross-site (out-of-process) iframe.
//   node docs/audit/fixtures/phase-b-server.mjs [port=41801]
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 41801);
// A syntactically valid JWT whose payload is {"sub":"admin","role":"owner"}; the signature is filler.
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJvd25lciJ9.c2lnbmF0dXJlLXNlY3JldC12YWx1ZQ';
const page = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">${head}
<style>body{font:15px system-ui;margin:24px}button,input,select{font:inherit;padding:6px 10px;margin:4px}</style></head>
<body>${body}</body></html>`;

const cjkParagraph = '這是一段用來測試跨封包切斷的繁體中文內容，包含標點符號「」與表情符號😀。';
const pages = {
  // B-01: Enter in the input adds an item; the aside link text matches "see … results".
  '/todo.html': page('Todo', `
<h1>Groceries</h1>
<input id="todo" aria-label="New item" placeholder="Add an item and press Enter">
<ul id="list"></ul>
<p>Keydown Enter events: <b id="keys">0</b></p>
<aside><h2>Elsewhere</h2><a href="/news/election">See full election results</a></aside>
<script>
const input = document.getElementById('todo');
input.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  document.getElementById('keys').textContent = Number(document.getElementById('keys').textContent) + 1;
  if (!input.value.trim()) return;
  const li = document.createElement('li'); li.textContent = input.value; document.getElementById('list').append(li);
  input.value = '';
});
</script>`),
  // B-01: a form with no links at all; Enter submits it.
  '/todo-plain.html': page('Todo plain', `
<h1>Groceries</h1>
<form id="f"><input id="todo" aria-label="New item"><button>Add</button></form>
<ul id="list"></ul>
<p>Submits: <b id="submits">0</b></p>
<script>
document.getElementById('f').addEventListener('submit', e => {
  e.preventDefault();
  document.getElementById('submits').textContent = Number(document.getElementById('submits').textContent) + 1;
  const input = document.getElementById('todo');
  const li = document.createElement('li'); li.textContent = input.value; document.getElementById('list').append(li);
  input.value = '';
});
</script>`),
  '/news/election': page('Election results', '<h1>Election results article</h1>'),
  // B-02
  '/select.html': page('Select', `
<label>Plan <select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro</option><option value="team">Team</option></select></label>
<p>Chosen: <b id="chosen">free</b></p>
<script>document.getElementById('plan').addEventListener('change', e => { document.getElementById('chosen').textContent = e.target.value; });</script>`),
  // B-03: open as /secrets.html?token=SECRET_URL_TOKEN_123&user=alice
  '/secrets.html': page('Account', `
<h1>Account settings</h1>
<p>Signed in as alice</p>
<button id="save" onclick="document.getElementById('st').textContent='Saved'">Save</button> <span id="st"></span>
<script>
document.cookie = 'auth_jwt=${JWT}; path=/';
console.log('calling /api/me with Authorization: Bearer ${JWT}');
console.error('refresh failed for https://api.example.test/v1/session?access_token=SECRET_ACCESS_777&user=alice');
fetch('/api/me', { headers: { Authorization: 'Bearer ${JWT}' } });
</script>`),
  // B-07, B-08(a)
  '/iframe-host.html': page('Iframe host', `
<h1>Billing</h1>
<button id="outer">Outer button</button>
<h2>Same-origin frame</h2><iframe id="same" src="/inner.html?frame=same" width="420" height="150"></iframe>
<h2>Cross-site frame</h2><iframe id="cross" src="http://localhost:${port}/inner.html?frame=cross" width="420" height="150"></iframe>`),
  '/inner.html': page('Inner', `
<label>Card holder <input id="holder" aria-label="Card holder"></label>
<button id="pay" onclick="document.getElementById('r').textContent='Paid by '+document.getElementById('holder').value">Pay now</button>
<p id="r"></p>`),
  // B-09: the document does not scroll; <main> does.
  '/scroll-shell.html': page('Shell', `
<style>html,body{height:100%;margin:0;overflow:hidden}header{height:56px;background:#eee;display:flex;align-items:center;padding:0 16px}
main{position:absolute;top:56px;bottom:0;left:0;right:0;overflow:auto;padding:16px}</style>
<header>Admin shell</header>
<main id="main">${Array.from({ length: 200 }, (_, i) => `<p>Row ${i + 1}</p>`).join('')}<button id="end">Load older entries</button></main>`),
  // B-10, O-05: a fixed consent banner covers the Save button.
  '/overlay.html': page('Overlay', `
<h1>Profile</h1>
<button id="save" style="position:absolute;top:300px;left:40px" onclick="document.getElementById('st').textContent='Saved'">Save profile</button>
<p id="st" style="position:absolute;top:340px;left:40px"></p>
<div id="consent" style="position:fixed;left:0;right:0;top:250px;height:200px;background:rgba(0,0,0,.85);color:#fff;padding:20px">
We use cookies. <button id="accept" onclick="document.getElementById('consent').remove()">Accept all</button></div>`),
  // O-01
  '/shadow.html': page('Shadow', `
<h1>Preferences</h1>
<settings-panel></settings-panel>
<p id="st"></p>
<script>
customElements.define('settings-panel', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<label>Display name <input id="name" aria-label="Display name"></label><button id="save">Save preferences</button>';
    root.getElementById('save').addEventListener('click', () => {
      document.getElementById('st').textContent = 'Saved ' + root.getElementById('name').value;
    });
  }
});
</script>`),
  // T-04, O-15
  '/dialog.html': page('Dialog', `
<h1>Items</h1>
<button id="del" onclick="document.getElementById('st').textContent = confirm('Delete item?') ? 'Deleted' : 'Kept'">Delete item</button>
<button id="hello" onclick="alert('Hello'); document.getElementById('st').textContent='Alerted'">Say hello</button>
<p id="st"></p>`),
  // B-08(b)(c), O-09. A plain click on #dl saves report.csv into the browser's download folder.
  '/download.html': page('Download', `
<h1>Reports</h1>
<a id="dl" href="/report.csv" download>Download report</a>
<button id="popup" onclick="window.open('/inner.html?frame=popup', '_blank')">Open in new window</button>`),
  // B-02
  '/upload.html': page('Upload', `
<h1>Avatar</h1>
<label>Avatar <input type="file" id="file" aria-label="Avatar"></label>
<p id="st"></p>
<script>document.getElementById('file').addEventListener('change', e => { document.getElementById('st').textContent = 'Chosen: ' + [...e.target.files].map(f => f.name + ' ' + f.size).join(', '); });</script>`),
  // O-10, T-08
  '/spa.html': page('Catalog', `
<div id="app"></div>
<script>
const items = ['Alpha', 'Beta', 'Gamma'];
function list() {
  document.getElementById('app').innerHTML = '<h1>Catalog</h1>' + items.map((n, i) => '<button data-i="' + i + '">Open ' + n + '</button>').join('');
  document.querySelectorAll('[data-i]').forEach(b => b.onclick = () => detail(Number(b.dataset.i)));
}
function detail(i) {
  document.getElementById('app').innerHTML = '<h1>' + items[i] + ' detail</h1><p>Price: ' + (i + 1) * 10 + '</p><button id="back">Back to catalog</button>';
  document.getElementById('back').onclick = list;
}
list();
</script>`),
  // T-07
  '/net.html': page('Network', `
<h1>Sync</h1>
<button id="s500" onclick="fetch('/api/500', {method:'POST'}).then(r => document.getElementById('st').textContent = 'HTTP ' + r.status)">Sync (500)</button>
<button id="s404" onclick="fetch('/api/404').then(r => document.getElementById('st').textContent = 'HTTP ' + r.status)">Load (404)</button>
<button id="soff" onclick="fetch('http://127.0.0.1:9/offline').catch(e => document.getElementById('st').textContent = 'Failed: ' + e.message)">Offline</button>
<p id="st"></p>`),
  // O-02, T-01: about 459 KB of CJK text.
  '/cjk.html': page('CJK', `<h1>中文</h1><div id="big">${Array.from({ length: 4000 }, (_, i) => `<p>${i} ${cjkParagraph}</p>`).join('')}</div>`),
  // B-11, O-07: window.insertTop() puts a destructive button above the others.
  '/refs.html': page('Refs', `
<h1>Team</h1>
<div id="box"><button id="b1">Invite Ann</button><button id="b2">Invite Bob</button><button id="b3">Invite Cy</button></div>
<p id="st"></p>
<script>
document.getElementById('box').addEventListener('click', e => { if (e.target.id) document.getElementById('st').textContent = 'Clicked ' + e.target.textContent; });
window.insertTop = () => { const b = document.createElement('button'); b.id = 'b0'; b.textContent = 'Remove everyone'; document.getElementById('box').prepend(b); };
</script>`),
  // T-05: enabled 1.5 s after load.
  '/late.html': page('Late', `
<h1>Checkout</h1>
<button id="buy" disabled onclick="document.getElementById('st').textContent='Bought'">Buy</button>
<p id="st"></p>
<script>setTimeout(() => { document.getElementById('buy').disabled = false; }, 1500);</script>`),
};

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/secrets.html') {
    res.setHeader('set-cookie', ['sid=SECRET_SESSION_8f3k2q9; Path=/; HttpOnly', 'theme=dark; Path=/']);
  }
  if (pages[url.pathname]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pages[url.pathname]);
    return;
  }
  if (url.pathname === '/search') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Search', `<h1>Results for ${(url.searchParams.get('q') || '').replace(/[<&]/g, '')}</h1>`));
    return;
  }
  if (url.pathname === '/report.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' });
    res.end('id,total\n1,10\n2,20\n');
    return;
  }
  if (url.pathname === '/api/me') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"user":"alice"}');
    return;
  }
  if (url.pathname === '/api/500') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"sync backend unavailable"}');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
}).listen(port, '127.0.0.1', () => console.log(`Phase B fixtures on http://127.0.0.1:${port}`));
