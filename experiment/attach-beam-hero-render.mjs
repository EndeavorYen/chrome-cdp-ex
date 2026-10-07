#!/usr/bin/env node
/**
 * Attach Beam hero renderer
 * Captures 1920×1080 frames from attach-beam-hero.html via Playwright,
 * then muxes with ffmpeg → mp4 + poster PNG.
 *
 * Build-time only. Does not touch product package.json.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, rm, copyFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname);
const HTML = path.join(ROOT, 'attach-beam-hero.html');
const OUT_MP4 = path.join(ROOT, 'attach-beam-hero.mp4');
const OUT_POSTER = path.join(ROOT, 'attach-beam-hero-poster.png');
const WORKSPACE_COPY = '/workspace/chrome-cdp-ex-motion';
const FRAMES_DIR = path.join(WORKSPACE_COPY, 'frames');

const DURATION = 15; // seconds
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const TOTAL = DURATION * FPS;
const POSTER_T = 1.0; // seconds into video

function findPlaywright() {
  const candidates = [
    path.join(WORKSPACE_COPY, 'node_modules', 'playwright'),
    path.join(WORKSPACE_COPY, 'node_modules', 'playwright-core'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      const req = createRequire(path.join(WORKSPACE_COPY, 'package.json'));
      return req('playwright');
    }
  }
  // fallback: try local
  try {
    const req = createRequire(path.join(ROOT, 'package.json'));
    return req('playwright');
  } catch {
    const req = createRequire(import.meta.url);
    return req('playwright');
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function main() {
  console.log('[attach-beam] HTML:', HTML);
  await access(HTML);
  await mkdir(FRAMES_DIR, { recursive: true });
  await mkdir(WORKSPACE_COPY, { recursive: true });

  // clean old frames
  await rm(FRAMES_DIR, { recursive: true, force: true });
  await mkdir(FRAMES_DIR, { recursive: true });

  const { chromium } = findPlaywright();
  console.log('[attach-beam] launching chromium…');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--font-render-hinting=none',
      '--disable-lcd-text',
    ],
  });
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  const fileUrl = pathToFileURL(HTML).href + '?play=0&t=0';
  await page.goto(fileUrl, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__attachBeam && typeof globalThis.__attachBeam.render === 'function');

  console.log(`[attach-beam] capturing ${TOTAL} frames @ ${FPS}fps (${DURATION}s)…`);
  const t0 = Date.now();
  for (let i = 0; i < TOTAL; i++) {
    const t = i / FPS;
    await page.evaluate((time) => {
      globalThis.__attachBeam.setTime(time);
      return new Promise((r) => globalThis.requestAnimationFrame(r));
    }, t);
    const framePath = path.join(FRAMES_DIR, `frame-${String(i).padStart(5, '0')}.jpg`);
    await page.screenshot({ path: framePath, type: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    if (i % 30 === 0 || i === TOTAL - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const pct = ((i / (TOTAL - 1)) * 100).toFixed(1);
      console.log(`  frame ${i + 1}/${TOTAL} (${pct}%) t=${t.toFixed(2)}s elapsed=${elapsed}s`);
    }
  }

  // poster at ~2.5s
  console.log(`[attach-beam] poster at t=${POSTER_T}s…`);
  await page.evaluate((time) => globalThis.__attachBeam.setTime(time), POSTER_T);
  await page.evaluate(() => new Promise((r) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(r))));
  await page.screenshot({ path: OUT_POSTER, type: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });

  await browser.close();

  console.log('[attach-beam] ffmpeg → mp4…');
  await run('ffmpeg', [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(FRAMES_DIR, 'frame-%05d.jpg'),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.2',
    '-crf', '18',
    '-preset', 'medium',
    '-movflags', '+faststart',
    '-an',
    OUT_MP4,
  ]);

  // copies into workspace
  await copyFile(OUT_MP4, path.join(WORKSPACE_COPY, 'attach-beam-hero.mp4'));
  await copyFile(OUT_POSTER, path.join(WORKSPACE_COPY, 'attach-beam-hero-poster.png'));
  await copyFile(HTML, path.join(WORKSPACE_COPY, 'attach-beam-hero.html'));
  await copyFile(path.join(ROOT, 'attach-beam-hero-render.mjs'), path.join(WORKSPACE_COPY, 'attach-beam-hero-render.mjs'));

  console.log('[attach-beam] done.');
  console.log('  mp4   ', OUT_MP4);
  console.log('  poster', OUT_POSTER);
  console.log('  copy  ', WORKSPACE_COPY);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
