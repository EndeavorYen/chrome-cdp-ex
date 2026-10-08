#!/usr/bin/env node
/**
 * Attach Beam hero renderer.
 *
 * Captures 1920×1080 JPEG frames from attach-beam-hero.html with Playwright,
 * then muxes them with ffmpeg into attach-beam-hero.mp4 and a poster PNG.
 *
 * Build-time only. Does not touch product package.json. Playwright is not a
 * dependency, so CI and the release tarball stay lean. Install it once
 * outside this repo, then point the script at that prefix:
 *
 *   npm install --no-save --prefix /tmp/attach-beam-playwright playwright
 *   ATTACH_BEAM_BROWSER_CHANNEL=chrome ATTACH_BEAM_PLAYWRIGHT=/tmp/attach-beam-playwright \
 *     node experiment/attach-beam-hero-render.mjs
 *
 * That package does not download a browser. `--browser-channel chrome` uses an
 * installed Google Chrome. To use Playwright's Chromium instead, run
 * `npx playwright install chromium` in that prefix and omit the channel.
 *
 * Paths default to this repository. A flag overrides the matching environment
 * variable. Relative paths resolve from the current working directory.
 *
 *   --out-dir <dir>         mp4 and poster (default: this script's directory)
 *   --frames-dir <dir>      JPEG scratch frames (default: <repo>/.attach-beam-frames)
 *   --copy-dir <dir>        also copy the mp4, poster, html, and this script
 *   --playwright <dir>      npm prefix whose node_modules contains playwright
 *   --browser-channel <id>  Playwright browser channel, such as chrome
 *   --dry-run               print the resolved plan and exit
 *   --help                  print usage
 *
 *   ATTACH_BEAM_OUT_DIR
 *   ATTACH_BEAM_FRAMES_DIR
 *   ATTACH_BEAM_COPY_DIR
 *   ATTACH_BEAM_PLAYWRIGHT
 *   ATTACH_BEAM_BROWSER_CHANNEL
 *
 * The committed poster is the hook frame at 1.0s. Its on-screen clock reads
 * 00:01, which matches experiment/attach-beam-hero-poster.png. Contrast
 * begins at 2s (clock 00:02).
 *
 * JPEG frames decode as full-range yuvj420p. -pix_fmt yuv420p alone can leave
 * the file tagged yuvj420p (color_range pc). The scale filter converts those
 * frames to limited-range yuv420p before libx264.
 */
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);

export const DURATION = 15;
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
/** Hook frame. The committed poster clock reads 00:01. */
export const POSTER_T = 1.0;
/** Full-range JPEG to limited-range 4:2:0. */
export const JPEG_TO_TV_FILTER = 'scale=out_range=tv,format=yuv420p';

const PLAYWRIGHT_INSTALL = 'npm install --no-save --prefix /tmp/attach-beam-playwright playwright';
const PLAYWRIGHT_RUN = 'ATTACH_BEAM_BROWSER_CHANNEL=chrome ATTACH_BEAM_PLAYWRIGHT=/tmp/attach-beam-playwright node experiment/attach-beam-hero-render.mjs';

export const USAGE = [
  'Usage: node experiment/attach-beam-hero-render.mjs [--out-dir dir] [--frames-dir dir]',
  '       [--copy-dir dir] [--playwright dir] [--browser-channel id] [--dry-run]',
  '',
  'Playwright is not a package dependency. Install it once, outside this repo:',
  `  ${PLAYWRIGHT_INSTALL}`,
  `  ${PLAYWRIGHT_RUN}`,
].join('\n');

const FLAG_VALUE = {
  '--out-dir': 'outDir',
  '--frames-dir': 'framesDir',
  '--copy-dir': 'copyDir',
  '--playwright': 'playwrightDir',
  '--browser-channel': 'browserChannel',
};

function fail(message, next) {
  return new Error(`${message}\nNext: ${next}`);
}

export function parseAttachBeamArgs(argv) {
  const flags = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      flags.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    const key = FLAG_VALUE[arg];
    if (!key) {
      throw fail(`Unknown argument ${arg}.`, 'node experiment/attach-beam-hero-render.mjs --help');
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw fail(`Missing value for ${arg}.`, 'node experiment/attach-beam-hero-render.mjs --help');
    }
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function firstSet(...values) {
  for (const value of values) {
    if (value != null && value !== '') return value;
  }
  return null;
}

function resolveChosen(cwd, value) {
  return value ? path.resolve(cwd, value) : null;
}

export function resolveAttachBeamPaths({
  scriptDir = SCRIPT_DIR,
  repoRoot = path.resolve(scriptDir, '..'),
  env = process.env,
  argv = [],
  cwd = process.cwd(),
} = {}) {
  const flags = parseAttachBeamArgs(argv);
  const resolvedScriptDir = path.resolve(scriptDir);
  const outDir = resolveChosen(cwd, firstSet(flags.outDir, env.ATTACH_BEAM_OUT_DIR))
    ?? resolvedScriptDir;
  const framesDir = resolveChosen(cwd, firstSet(flags.framesDir, env.ATTACH_BEAM_FRAMES_DIR))
    ?? path.resolve(repoRoot, '.attach-beam-frames');
  return {
    scriptDir: resolvedScriptDir,
    repoRoot: path.resolve(repoRoot),
    html: path.join(resolvedScriptDir, 'attach-beam-hero.html'),
    scriptPath: path.join(resolvedScriptDir, 'attach-beam-hero-render.mjs'),
    outDir,
    outMp4: path.join(outDir, 'attach-beam-hero.mp4'),
    outPoster: path.join(outDir, 'attach-beam-hero-poster.png'),
    framesDir,
    copyDir: resolveChosen(cwd, firstSet(flags.copyDir, env.ATTACH_BEAM_COPY_DIR)),
    playwrightDir: resolveChosen(cwd, firstSet(flags.playwrightDir, env.ATTACH_BEAM_PLAYWRIGHT)),
    browserChannel: firstSet(flags.browserChannel, env.ATTACH_BEAM_BROWSER_CHANNEL),
    dryRun: flags.dryRun,
    help: flags.help,
  };
}

export function ffmpegMuxArgs({ framesDir, fps = FPS, outMp4 }) {
  return [
    '-y',
    '-framerate', String(fps),
    '-i', path.join(framesDir, 'frame-%05d.jpg'),
    '-vf', JPEG_TO_TV_FILTER,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.2',
    '-crf', '18',
    '-preset', 'medium',
    '-movflags', '+faststart',
    '-an',
    outMp4,
  ];
}

export function buildAttachBeamPlan(options) {
  const paths = resolveAttachBeamPaths(options);
  return {
    ...paths,
    posterT: POSTER_T,
    fps: FPS,
    duration: DURATION,
    width: WIDTH,
    height: HEIGHT,
    totalFrames: DURATION * FPS,
    ffmpeg: ffmpegMuxArgs({ framesDir: paths.framesDir, fps: FPS, outMp4: paths.outMp4 }),
  };
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertSafeFramesDir(plan) {
  const frames = path.resolve(plan.framesDir);
  const blocked = [
    path.parse(frames).root,
    plan.repoRoot,
    plan.scriptDir,
    plan.outDir,
  ].some(dir => path.resolve(dir) === frames);
  const coversSource = isInside(frames, plan.repoRoot)
    || isInside(frames, plan.html)
    || isInside(frames, plan.scriptPath);
  if (blocked || coversSource) {
    throw fail(
      `Refusing to wipe ${frames}. That directory is the repo, the script, the output, a parent of those, or a filesystem root.`,
      'node experiment/attach-beam-hero-render.mjs --frames-dir .attach-beam-frames',
    );
  }
}

export function formatDryRun(plan) {
  return [
    '[attach-beam] dry-run',
    `html=${plan.html}`,
    `outMp4=${plan.outMp4}`,
    `outPoster=${plan.outPoster}`,
    `framesDir=${plan.framesDir}`,
    `copyDir=${plan.copyDir ?? ''}`,
    `playwrightDir=${plan.playwrightDir ?? ''}`,
    `browserChannel=${plan.browserChannel ?? ''}`,
    `posterT=${plan.posterT.toFixed(1)}`,
    `ffmpegFilter=${JPEG_TO_TV_FILTER}`,
    `ffmpeg=${['ffmpeg', ...plan.ffmpeg].join(' ')}`,
  ].join('\n');
}

export function loadPlaywright(plan, requireFrom = createRequire) {
  const loadFrom = (anchor) => requireFrom(anchor)('playwright');
  if (plan.playwrightDir) {
    try {
      return loadFrom(path.join(plan.playwrightDir, 'package.json'));
    } catch (err) {
      throw fail(
        `playwright was not found at ${plan.playwrightDir} (${err.message}).`,
        `${PLAYWRIGHT_INSTALL} && ${PLAYWRIGHT_RUN}`,
      );
    }
  }
  try {
    return loadFrom(SCRIPT_PATH);
  } catch (err) {
    throw fail(
      `playwright is not installed (${err.message}). It is not a package dependency.`,
      `${PLAYWRIGHT_INSTALL} && ${PLAYWRIGHT_RUN}`,
    );
  }
}

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    child.on('error', (error) => {
      const next = error.code === 'ENOENT'
        ? `install ${cmd}, then re-run node experiment/attach-beam-hero-render.mjs`
        : 'node experiment/attach-beam-hero-render.mjs --dry-run';
      finish(fail(`Could not start ${cmd} (${error.message}).`, next));
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(fail(
        `${cmd} exited ${code ?? signal}.`,
        'node experiment/attach-beam-hero-render.mjs --dry-run',
      ));
    });
  });
}

async function captureFrames(plan, playwright) {
  await rm(plan.framesDir, { recursive: true, force: true });
  await mkdir(plan.framesDir, { recursive: true });
  await mkdir(plan.outDir, { recursive: true });

  const launchOptions = {
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--font-render-hinting=none',
      '--disable-lcd-text',
    ],
  };
  if (plan.browserChannel) launchOptions.channel = plan.browserChannel;

  console.log('[attach-beam] launching chromium…');
  const browser = await playwright.chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({
      viewport: { width: plan.width, height: plan.height },
      deviceScaleFactor: 1,
    });
    const fileUrl = `${pathToFileURL(plan.html).href}?play=0&t=0`;
    await page.goto(fileUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => globalThis.__attachBeam && typeof globalThis.__attachBeam.render === 'function');

    console.log(`[attach-beam] capturing ${plan.totalFrames} frames @ ${plan.fps}fps (${plan.duration}s)…`);
    const started = Date.now();
    for (let i = 0; i < plan.totalFrames; i += 1) {
      const t = i / plan.fps;
      await page.evaluate((time) => {
        globalThis.__attachBeam.setTime(time);
        return new Promise((done) => globalThis.requestAnimationFrame(done));
      }, t);
      const framePath = path.join(plan.framesDir, `frame-${String(i).padStart(5, '0')}.jpg`);
      await page.screenshot({
        path: framePath,
        type: 'jpeg',
        quality: 90,
        clip: { x: 0, y: 0, width: plan.width, height: plan.height },
      });
      if (i % plan.fps === 0 || i === plan.totalFrames - 1) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const pct = ((i / (plan.totalFrames - 1)) * 100).toFixed(1);
        console.log(`  frame ${i + 1}/${plan.totalFrames} (${pct}%) t=${t.toFixed(2)}s elapsed=${elapsed}s`);
      }
    }

    // Hook frame at POSTER_T (1.0s). The committed poster clock reads 00:01.
    console.log(`[attach-beam] poster at t=${plan.posterT.toFixed(1)}s…`);
    await page.evaluate((time) => globalThis.__attachBeam.setTime(time), plan.posterT);
    await page.evaluate(() => new Promise((done) => {
      globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(done));
    }));
    await page.screenshot({
      path: plan.outPoster,
      type: 'png',
      clip: { x: 0, y: 0, width: plan.width, height: plan.height },
    });
  } finally {
    await browser.close();
  }
}

async function copyOutputs(plan) {
  await mkdir(plan.copyDir, { recursive: true });
  await copyFile(plan.outMp4, path.join(plan.copyDir, 'attach-beam-hero.mp4'));
  await copyFile(plan.outPoster, path.join(plan.copyDir, 'attach-beam-hero-poster.png'));
  await copyFile(plan.html, path.join(plan.copyDir, 'attach-beam-hero.html'));
  await copyFile(plan.scriptPath, path.join(plan.copyDir, 'attach-beam-hero-render.mjs'));
}

async function requireHtml(plan) {
  try {
    await access(plan.html);
  } catch (err) {
    throw fail(
      `HTML not found at ${plan.html} (${err.message}).`,
      'node experiment/attach-beam-hero-render.mjs --dry-run',
    );
  }
}

export async function runAttachBeam(options = {}) {
  const plan = buildAttachBeamPlan(options);
  if (plan.help) {
    console.log(USAGE);
    return { plan, helped: true };
  }
  if (plan.dryRun) {
    const text = formatDryRun(plan);
    console.log(text);
    return { plan, dryRun: true, text };
  }

  await requireHtml(plan);
  assertSafeFramesDir(plan);
  const playwright = options.loadPlaywright
    ? await options.loadPlaywright(plan)
    : loadPlaywright(plan);
  const capture = options.captureFrames ?? captureFrames;
  await capture(plan, playwright);
  const mux = options.mux ?? ((ready) => runProcess('ffmpeg', ready.ffmpeg));
  console.log('[attach-beam] ffmpeg → mp4…');
  await mux(plan);
  if (plan.copyDir) {
    const copy = options.copyOutputs ?? copyOutputs;
    await copy(plan);
  }
  console.log('[attach-beam] done.');
  console.log('  mp4   ', plan.outMp4);
  console.log('  poster', plan.outPoster);
  if (plan.copyDir) console.log('  copy  ', plan.copyDir);
  return { plan };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === SCRIPT_PATH;
}

if (invokedDirectly()) {
  runAttachBeam({ argv: process.argv.slice(2) }).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
