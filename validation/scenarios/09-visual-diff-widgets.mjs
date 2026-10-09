#!/usr/bin/env node
// Agent scenario 9 (docs/audit/scenarios.md): toggle a theme and say which widgets changed. Only CSS
// changes, so the DOM and the accessibility tree are identical before and after: the answer needs pixels.
import {
  commandLines, commonChecks, page, prefixFromList, runScenario, sendHtml, sendJson, verdict,
} from '../../scripts/lib/agent-scenario-harness.mjs';

export const scenario = {
  id: 'agent-09-visual-diff-widgets',
  type: 9,
  kind: 'static-page',
  title: 'Say which dashboard widgets look different after "Apply new theme"',
  userWords: '按下「Apply new theme」之後，四個小工具裡哪幾個的外觀變了？告訴我名稱就好，不要截整頁長圖。',
  startState: [
    'A static dashboard on 127.0.0.1, one tab: "Dashboard · Acme Analytics", fitting in one viewport.',
    'Four widget cards: Revenue, Active users, Churn, Tickets. A toggle button "Apply new theme" (aria-pressed).',
    'The theme changes only CSS (no text, no DOM, no accessibility change in the cards): Revenue gets a blue band and tint, Churn a red dashed border and red figure.',
  ],
  allowedOracle: ['diff-shot, shot, elshot (and looking at the images); computed styles (cascade, styles).'],
  forbiddenShortcuts: [
    { id: 'full-page-capture', description: 'Taking a full-page long screenshot (scanshot, fullshot) for a page that fits in one viewport, against the user\'s words.', detectedBy: 'transcript: scanshot or fullshot' },
  ],
  successCondition: [
    'Answer: names Revenue and Churn as changed and does not name Active users or Tickets as changed.',
    'Browser: the new theme is applied at the end (the user asked to press the button).',
    'Transcript: no scanshot or fullshot.',
  ],
  failureTaxonomy: [
    { code: 'wrong-widgets', description: 'The answer misses Revenue or Churn, or names an unchanged widget as changed.' },
    { code: 'theme-not-applied', description: 'The theme is off at the end.' },
    { code: 'full-page-capture', description: 'scanshot or fullshot was used.' },
    { code: 'secret-leak', description: 'A secret value appeared in the transcript (none are planted here).' },
  ],
  weakModelTraps: [
    { trap: '`perceive --since-action` after the click shows only the toggle\'s pressed state; the cards look unchanged in text form.', refs: 'scenario' },
    { trap: 'A diff-shot baseline taken after the click compares the new state with itself (0 px changed).', refs: 'scenario' },
    { trap: 'The compare receipt also names the toggled "Apply new theme" button among the changed regions; it is not a widget.', refs: '#661' },
    { trap: 'Runtime hints name scanshot for full captures.', refs: 'A-08' },
    { trap: 'Before #661 the compare receipt gave only a changed-pixel ratio and three PNG paths, and SKILL.md did not name diff-shot; Haiku hashed every card\'s computed styles with eval (37,106 chars).', refs: 'Phase D' },
  ],
  referencePath: [
    'list → the "Dashboard · Acme Analytics" tab',
    'diff-shot <t> (baseline)',
    'click <t> "#apply-theme"',
    'diff-shot <t> (compare) → Changed regions: <SECTION#w-revenue> "Revenue", <BUTTON#apply-theme>, <SECTION#w-churn> "Churn"',
  ],
};

const CARDS = [
  ['revenue', 'Revenue', '$1.24M', '+4.1% vs last month'],
  ['users', 'Active users', '8,421', '+212 this week'],
  ['churn', 'Churn', '2.1%', '−0.3 pts'],
  ['tickets', 'Tickets', '37', '9 waiting on customer'],
];

const DASHBOARD = page('Dashboard · Acme Analytics', `
<style>
*{transition:none!important;animation:none!important}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.w{min-height:150px}.w h2{margin:0 0 6px;font-size:15px;color:#656d76}
.w .n{font-size:34px;font-weight:700}.w .d{color:#656d76}
html.theme-v2 #w-revenue{background:#eef6ff;border-left:8px solid #0969da}
html.theme-v2 #w-churn{border:2px dashed #cf222e}html.theme-v2 #w-churn .n{color:#cf222e}
#apply-theme[aria-pressed=true]{background:#24292f;color:#fff}
</style>
<header class="top"><span class="brand">Acme Analytics</span><a href="/dashboard">Dashboard</a><span class="who">ann@acme.example</span></header>
<main><h1>Dashboard</h1><p><button id="apply-theme" aria-pressed="false">Apply new theme</button></p>
<div class="grid">${CARDS.map(([id, title, n, d]) => `<section class="card w" id="w-${id}" aria-label="${title}"><h2>${title}</h2><div class="n">${n}</div><div class="d">${d}</div></section>`).join('')}</div></main>
<script>
document.getElementById('apply-theme').addEventListener('click', e => {
  const on = document.documentElement.classList.toggle('theme-v2');
  e.currentTarget.setAttribute('aria-pressed', String(on));
});
</script>`, { app: 'analytics' });

export function createApps() {
  return {
    app: {
      host: '127.0.0.1',
      handler(req, res) {
        if (new URL(req.url, 'http://app').pathname === '/dashboard') { sendHtml(res, DASHBOARD); return; }
        sendJson(res, 404, { error: 'not found' });
      },
    },
  };
}

export async function setup(ctx) {
  ctx.state.tab = await ctx.openTab(ctx.url('app', '/dashboard'), { activate: true });
  await ctx.closeBlankTabs();
  await ctx.waitFor(ctx.state.tab, `document.readyState === 'complete' && !!document.getElementById('w-tickets')`);
}

async function tab(ctx) {
  return prefixFromList((await ctx.cli('list')).stdout, row => row.title.startsWith('Dashboard'));
}

export async function reference(ctx) {
  const t = await tab(ctx);
  await ctx.cli('diff-shot', t);
  await ctx.cli('click', t, '#apply-theme');
  const compare = (await ctx.cli('diff-shot', t)).stdout;
  // The compare receipt names the element that holds each changed region. The widgets are the
  // <section> cards; the pressed "Apply new theme" button is listed too, and is not a widget.
  const changed = [...compare.matchAll(/^\s+<SECTION[^>]*> "([^"]+)"/gm)].map(match => match[1]);
  return { answer: `外觀改變的是：${changed.join('、')}。` };
}

// The weak-model path: compare text views, and take a full-page capture "to be sure".
export async function trap(ctx) {
  const t = await tab(ctx);
  await ctx.cli('perceive', t);
  await ctx.cli('click', t, '#apply-theme');
  await ctx.cli('perceive', t, '--since-action');
  await ctx.cli('scanshot', t);
  return { answer: '四個小工具都沒有變，只有按鈕變成按下狀態。', expect: ['wrong-widgets', 'full-page-capture'] };
}

export async function judge(ctx, { answer, transcript }) {
  const revenue = /revenue|營收|收入/i.test(answer);
  const churn = /churn|流失/i.test(answer);
  const others = /active users|活躍|tickets|工單/i.test(answer);
  const negated = /沒變|沒有變|未變|不變|unchanged|did not change|didn't change|no change/i.test(answer);
  const applied = await ctx.evaluate(ctx.state.tab, `document.documentElement.classList.contains('theme-v2')`).catch(() => false);
  const capture = commandLines(transcript).filter(line => /^(scanshot|fullshot)\b/.test(line));
  return verdict([
    { code: 'wrong-widgets', ok: revenue && churn && (!others || negated), detail: `revenue=${revenue} churn=${churn} others=${others}` },
    { code: 'theme-not-applied', ok: applied === true, detail: '' },
    { code: 'full-page-capture', ok: capture.length === 0, detail: capture.join('; ') },
    ...commonChecks(ctx, { transcript }),
  ]);
}

runScenario(import.meta.url, { scenario, createApps, setup, reference, trap, judge });
