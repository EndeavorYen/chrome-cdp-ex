#!/usr/bin/env node
// Agent scenario 12 (docs/audit/scenarios.md): answer a question that only the pixels of a WebGL canvas
// can answer. perceive and text see a canvas element and a legend, nothing else.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  commonChecks, decodePng, page, prefixFromList, runScenario, sendHtml, sendJson, verdict,
} from '../../scripts/lib/agent-scenario-harness.mjs';

export const scenario = {
  id: 'agent-12-webgl-canvas-read',
  type: 12,
  kind: 'static-page',
  title: 'Name the hottest node in a WebGL heatmap',
  userWords: '看一下這個叢集熱度圖，哪一個節點最熱（顏色最紅）？',
  startState: [
    'A static ops page on 127.0.0.1, one tab: "Cluster heatmap · Acme Ops".',
    'A 4×4 heatmap of nodes N-01…N-16 drawn with WebGL; the labels are drawn on a second (2D) canvas on top. Colour runs from blue (idle) to red (saturated).',
    'The load values come from /api/heat; nothing in the DOM or the accessibility tree carries them.',
  ],
  allowedOracle: ['shot or elshot of the canvas, then looking at the image.'],
  forbiddenShortcuts: [
    { id: 'direct-api', description: 'Reading /api/heat instead of the rendered heatmap.', detectedBy: 'server: request without the page\'s client header' },
  ],
  successCondition: ['Answer: N-07, and no other node named as the hottest.'],
  failureTaxonomy: [
    { code: 'wrong-node', description: 'The answer names another node, several nodes, or none.' },
    { code: 'direct-api', description: 'The data was read from the API instead of the picture.' },
    { code: 'not-rendered', description: 'The heatmap did not render (WebGL unavailable): an environment failure.' },
    { code: 'secret-leak', description: 'A secret value appeared in the transcript (none are planted here).' },
  ],
  weakModelTraps: [
    { trap: '`perceive` shows only the canvas (aria-label "Cluster heatmap"); `text` shows the legend.', refs: 'scenario' },
    { trap: 'The CLI prints a screenshot path; the agent must open the PNG itself. MCP inlines the image.', refs: 'token-perf.md §3' },
    { trap: 'N-12 is the second hottest and also reddish.', refs: 'scenario' },
  ],
  referencePath: [
    'list → the "Cluster heatmap · Acme Ops" tab',
    'elshot <t> "#stack" <file> → look at the image: the reddest cell is N-07',
  ],
};

const CLIENT = 'x-heat-client';
const LOADS = [0.31, 0.44, 0.52, 0.18, 0.63, 0.27, 0.97, 0.39, 0.12, 0.58, 0.71, 0.86, 0.22, 0.47, 0.35, 0.66];

const HEATMAP = page('Cluster heatmap · Acme Ops', `
<header class="top"><span class="brand">Acme Ops</span><a href="/heatmap">Heatmap</a><span class="who">oncall@acme.example</span></header>
<main><h1>Cluster heatmap</h1>
<div id="stack" style="position:relative;width:480px;height:480px">
<canvas id="heat" width="480" height="480" aria-label="Cluster heatmap" style="position:absolute;left:0;top:0"></canvas>
<canvas id="labels" width="480" height="480" aria-hidden="true" style="position:absolute;left:0;top:0"></canvas></div>
<p class="muted">Legend: blue = idle · red = saturated</p></main>
<script>
(async () => {
  const data = await fetch('/api/heat', { headers: { '${CLIENT}': 'web' } }).then(r => r.json());
  const gl = document.getElementById('heat').getContext('webgl', { preserveDrawingBuffer: true });
  if (!gl) { document.body.dataset.rendered = 'no-webgl'; return; }
  const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, 'attribute vec2 p;uniform vec4 rect;void main(){vec2 xy=rect.xy+p*rect.zw;gl_Position=vec4(xy.x*2.0-1.0,1.0-xy.y*2.0,0.0,1.0);}'));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, 'precision mediump float;uniform vec4 color;void main(){gl_FragColor=color;}'));
  gl.linkProgram(prog); gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 0,1, 1,0, 1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.clearColor(0.97, 0.97, 0.98, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  const labels = document.getElementById('labels').getContext('2d');
  labels.font = 'bold 18px system-ui'; labels.fillStyle = '#fff';
  data.nodes.forEach((node, i) => {
    const col = i % 4, row = Math.floor(i / 4), t = node.load;
    gl.uniform4f(gl.getUniformLocation(prog, 'rect'), col / 4 + 0.01, row / 4 + 0.01, 0.23, 0.23);
    gl.uniform4f(gl.getUniformLocation(prog, 'color'), 0.12 + 0.83 * t, 0.32 - 0.22 * t, 0.9 - 0.8 * t, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    labels.fillText(node.id, col * 120 + 14, row * 120 + 30);
  });
  document.body.dataset.rendered = 'yes';
})();
</script>`, { app: 'ops' });

export function createApps(ctx) {
  const state = ctx.state;
  state.log = [];
  return {
    app: {
      host: '127.0.0.1',
      handler(req, res) {
        const path = new URL(req.url, 'http://app').pathname;
        if (path === '/heatmap') { sendHtml(res, HEATMAP); return; }
        if (path === '/api/heat') {
          state.log.push({ at: Date.now(), fromUi: req.headers[CLIENT] === 'web' });
          sendJson(res, 200, { nodes: LOADS.map((load, i) => ({ id: `N-${String(i + 1).padStart(2, '0')}`, load })) });
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      },
    },
  };
}

export async function setup(ctx) {
  ctx.state.tab = await ctx.openTab(ctx.url('app', '/heatmap'), { activate: true });
  await ctx.closeBlankTabs();
  await ctx.waitFor(ctx.state.tab, `document.body.dataset.rendered`);
}

async function tab(ctx) {
  return prefixFromList((await ctx.cli('list')).stdout, row => row.title.startsWith('Cluster heatmap'));
}

export async function reference(ctx) {
  const t = await tab(ctx);
  const file = join(ctx.workDir, 'heatmap.png');
  await ctx.cli('elshot', t, '#stack', file);
  // "Look at" the picture: sample each cell's centre and take the reddest.
  const png = decodePng(readFileSync(file));
  const cell = png.width / 4;
  let best = { score: -Infinity, index: -1 };
  for (let i = 0; i < 16; i += 1) {
    const [r, , b] = png.pixel(Math.round((i % 4) * cell + cell * 0.6), Math.round(Math.floor(i / 4) * cell + cell * 0.6));
    if (r - b > best.score) best = { score: r - b, index: i };
  }
  return { answer: `最熱的是 N-${String(best.index + 1).padStart(2, '0')}。` };
}

// The weak-model path: read the page as text and report what it says.
export async function trap(ctx) {
  const t = await tab(ctx);
  await ctx.cli('perceive', t);
  await ctx.cli('text', t, '--auto');
  return { answer: '頁面只有一張畫布和圖例，看不出哪個節點最熱。', expect: ['wrong-node'] };
}

export async function judge(ctx, { answer, transcript }) {
  // The node named first is the one given as the hottest; a ranking after it ("N-12 second") is fine.
  const ids = answer.match(/N-\d\d/g) || [];
  const rendered = await ctx.evaluate(ctx.state.tab, `document.body.dataset.rendered || ''`).catch(() => '');
  return verdict([
    { code: 'wrong-node', ok: ids[0] === 'N-07', detail: [...new Set(ids)].join(', ') || 'no node named' },
    { code: 'direct-api', ok: ctx.state.log.every(e => e.fromUi), detail: '' },
    { code: 'not-rendered', ok: rendered === 'yes', detail: rendered },
    ...commonChecks(ctx, { transcript }),
  ]);
}

runScenario(import.meta.url, { scenario, createApps, setup, reference, trap, judge });
