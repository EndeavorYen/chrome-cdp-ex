import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FRAMES_MARKER,
  FRAMES_MARKER_TEXT,
  JPEG_TO_TV_FILTER,
  POSTER_T,
  USAGE,
  assertSafeFramesDir,
  buildAttachBeamPlan,
  ffmpegMuxArgs,
  loadPlaywright,
  prepareFramesDir,
  resolveAttachBeamPaths,
  runAttachBeam,
} from '../experiment/attach-beam-hero-render.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptDir = path.join(repoRoot, 'experiment');
const scriptPath = path.join(scriptDir, 'attach-beam-hero-render.mjs');

function layout() {
  const root = mkdtempSync(path.join(tmpdir(), 'attach-beam-'));
  const experiment = path.join(root, 'experiment');
  mkdirSync(experiment);
  writeFileSync(path.join(experiment, 'attach-beam-hero.html'), '<html></html>');
  writeFileSync(path.join(experiment, 'attach-beam-hero-render.mjs'), 'script');
  return { root, experiment };
}

describe('#591 attach beam hero render script', () => {
  it('keeps the poster at 1.0s and converts JPEG frames to limited-range yuv420p', () => {
    expect(POSTER_T).toBe(1);
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).not.toContain('/workspace/chrome-cdp-ex-motion');
    expect(source).not.toContain('poster at ~2.5s');
    expect(source).toContain('npm install --no-save --prefix /tmp/attach-beam-playwright playwright');
    expect(source).toContain(JPEG_TO_TV_FILTER);
    expect(USAGE).toContain('npm install --no-save --prefix /tmp/attach-beam-playwright playwright');

    const framesDir = path.join(tmpdir(), 'frames');
    const outMp4 = path.join(tmpdir(), 'out.mp4');
    const args = ffmpegMuxArgs({ framesDir, outMp4 });
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=out_range=tv,format=yuv420p');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    expect(args.at(-1)).toBe(outMp4);
  });

  it('resolves output and frames inside the repo, with CLI overriding env', () => {
    const cwd = path.join(tmpdir(), 'attach-beam-cwd');
    const env = {
      ATTACH_BEAM_OUT_DIR: path.join(tmpdir(), 'from-env-out'),
      ATTACH_BEAM_FRAMES_DIR: path.join(tmpdir(), 'from-env-frames'),
      ATTACH_BEAM_COPY_DIR: path.join(tmpdir(), 'from-env-copy'),
      ATTACH_BEAM_PLAYWRIGHT: path.join(tmpdir(), 'from-env-pw'),
      ATTACH_BEAM_BROWSER_CHANNEL: 'chrome',
    };
    const defaults = resolveAttachBeamPaths({
      scriptDir,
      repoRoot,
      cwd,
      env: {
        ATTACH_BEAM_OUT_DIR: '',
        ATTACH_BEAM_FRAMES_DIR: '',
        ATTACH_BEAM_COPY_DIR: '',
        ATTACH_BEAM_PLAYWRIGHT: '',
        ATTACH_BEAM_BROWSER_CHANNEL: '',
      },
      argv: [],
    });
    expect(defaults.outDir).toBe(scriptDir);
    expect(defaults.outMp4).toBe(path.join(scriptDir, 'attach-beam-hero.mp4'));
    expect(defaults.outPoster).toBe(path.join(scriptDir, 'attach-beam-hero-poster.png'));
    expect(defaults.framesDir).toBe(path.join(repoRoot, '.attach-beam-frames'));
    expect(defaults.copyDir).toBeNull();
    expect(defaults.playwrightDir).toBeNull();
    expect(defaults.browserChannel).toBeNull();
    expect(defaults.framesDir).not.toContain('chrome-cdp-ex-motion');

    const fromEnv = resolveAttachBeamPaths({ scriptDir, repoRoot, cwd, env, argv: [] });
    expect(fromEnv.outDir).toBe(path.resolve(env.ATTACH_BEAM_OUT_DIR));
    expect(fromEnv.framesDir).toBe(path.resolve(env.ATTACH_BEAM_FRAMES_DIR));
    expect(fromEnv.copyDir).toBe(path.resolve(env.ATTACH_BEAM_COPY_DIR));
    expect(fromEnv.playwrightDir).toBe(path.resolve(env.ATTACH_BEAM_PLAYWRIGHT));
    expect(fromEnv.browserChannel).toBe('chrome');

    const fromCli = resolveAttachBeamPaths({
      scriptDir,
      repoRoot,
      cwd,
      env,
      argv: [
        '--out-dir', 'cli-out',
        '--frames-dir', 'cli-frames',
        '--copy-dir', 'cli-copy',
        '--playwright', 'cli-pw',
        '--browser-channel', 'msedge',
        '--dry-run',
      ],
    });
    expect(fromCli.outDir).toBe(path.resolve(cwd, 'cli-out'));
    expect(fromCli.framesDir).toBe(path.resolve(cwd, 'cli-frames'));
    expect(fromCli.copyDir).toBe(path.resolve(cwd, 'cli-copy'));
    expect(fromCli.playwrightDir).toBe(path.resolve(cwd, 'cli-pw'));
    expect(fromCli.browserChannel).toBe('msedge');
    expect(fromCli.dryRun).toBe(true);
    expect(buildAttachBeamPlan({ scriptDir, repoRoot, cwd, env: {}, argv: [] }).posterT).toBe(1);
  });

  it('rejects unknown arguments and a frames directory that would wipe the repo', () => {
    expect(() => resolveAttachBeamPaths({ argv: ['--nope'] })).toThrow(/Unknown argument --nope/);
    expect(() => resolveAttachBeamPaths({ argv: ['--out-dir'] })).toThrow(/Missing value for --out-dir/);

    const plan = buildAttachBeamPlan({ scriptDir, repoRoot, env: {}, argv: [], cwd: repoRoot });
    expect(() => assertSafeFramesDir({ ...plan, framesDir: repoRoot })).toThrow(/Refusing to wipe/);
    expect(() => assertSafeFramesDir({ ...plan, framesDir: scriptDir })).toThrow(/Refusing to wipe/);
    expect(() => assertSafeFramesDir({ ...plan, framesDir: path.parse(repoRoot).root })).toThrow(/Refusing to wipe/);
    expect(() => assertSafeFramesDir(plan)).not.toThrow();
  });

  it('states the one-off playwright install when the module cannot be resolved', () => {
    const missing = () => {
      throw new Error('Cannot find module playwright');
    };
    const requireFrom = () => missing;
    expect(() => loadPlaywright({ playwrightDir: null }, requireFrom)).toThrow(/not a package dependency/);
    expect(() => loadPlaywright({ playwrightDir: path.join(tmpdir(), 'missing-pw') }, requireFrom))
      .toThrow(/Next: npm install --no-save --prefix \/tmp\/attach-beam-playwright playwright/);
    const mod = { chromium: { launch() {} } };
    expect(loadPlaywright({ playwrightDir: path.join(tmpdir(), 'pw') }, () => () => mod)).toBe(mod);
  });

  it('prints a repo-relative dry run and copies outputs only when asked', async () => {
    const dry = spawnSync(process.execPath, [scriptPath, '--dry-run'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain(`html=${path.join(scriptDir, 'attach-beam-hero.html')}`);
    expect(dry.stdout).toContain(`outMp4=${path.join(scriptDir, 'attach-beam-hero.mp4')}`);
    expect(dry.stdout).toContain(`framesDir=${path.join(repoRoot, '.attach-beam-frames')}`);
    expect(dry.stdout).toContain('copyDir=\n');
    expect(dry.stdout).toContain('posterT=1.0');
    expect(dry.stdout).toContain('ffmpegFilter=scale=out_range=tv,format=yuv420p');
    expect(dry.stdout).not.toContain('chrome-cdp-ex-motion');

    const help = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('npm install --no-save --prefix /tmp/attach-beam-playwright playwright');

    const unknown = spawnSync(process.execPath, [scriptPath, '--nope'], { encoding: 'utf8' });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Next: node experiment/attach-beam-hero-render.mjs --help');

    const { root, experiment } = layout();
    const copyDir = path.join(root, 'motion');
    const framesDir = mkdtempSync(path.join(tmpdir(), 'attach-beam-scratch-'));
    const rendered = await runAttachBeam({
      scriptDir: experiment,
      repoRoot: root,
      cwd: root,
      env: {},
      argv: ['--copy-dir', copyDir, '--frames-dir', framesDir, '--browser-channel', 'chrome'],
      loadPlaywright: async () => ({ chromium: { launch() {} } }),
      captureFrames: async (plan) => {
        expect(plan.browserChannel).toBe('chrome');
        expect(plan.posterT).toBe(1);
        mkdirSync(plan.outDir, { recursive: true });
        writeFileSync(plan.outPoster, 'poster');
      },
      mux: async (plan) => {
        expect(plan.ffmpeg).toContain('scale=out_range=tv,format=yuv420p');
        writeFileSync(plan.outMp4, 'mp4');
      },
    });
    expect(rendered.plan.copyDir).toBe(copyDir);
    expect(readFileSync(path.join(copyDir, 'attach-beam-hero.mp4'), 'utf8')).toBe('mp4');
    expect(readFileSync(path.join(copyDir, 'attach-beam-hero-poster.png'), 'utf8')).toBe('poster');
    expect(readFileSync(path.join(copyDir, 'attach-beam-hero.html'), 'utf8')).toBe('<html></html>');
    expect(readFileSync(path.join(copyDir, 'attach-beam-hero-render.mjs'), 'utf8')).toBe('script');

    const skipped = await runAttachBeam({
      scriptDir: experiment,
      repoRoot: root,
      cwd: root,
      env: {},
      argv: ['--frames-dir', framesDir],
      loadPlaywright: async () => ({ chromium: {} }),
      captureFrames: async () => {},
      mux: async () => {},
      copyOutputs: async () => {
        throw new Error('copy should not run');
      },
    });
    expect(skipped.plan.copyDir).toBeNull();
  });

  it('stops before capture when the html is missing or the frames directory is unsafe', async () => {
    const { root } = layout();
    await expect(runAttachBeam({
      scriptDir: path.join(root, 'missing'),
      repoRoot: root,
      cwd: root,
      env: {},
      argv: [],
      loadPlaywright: async () => {
        throw new Error('should not load');
      },
    })).rejects.toThrow(/HTML not found/);

    await expect(runAttachBeam({
      scriptDir,
      repoRoot,
      cwd: repoRoot,
      env: {},
      argv: ['--frames-dir', repoRoot],
      loadPlaywright: async () => {
        throw new Error('should not load');
      },
    })).rejects.toThrow(/Refusing to wipe/);
  });

  it('refuses .git, a repo source folder, a non-empty home stand-in, and a parent of the output', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'attach-beam-guard-'));
    const repo = path.join(scratch, 'repo');
    const experiment = path.join(repo, 'experiment');
    mkdirSync(experiment, { recursive: true });
    writeFileSync(path.join(experiment, 'attach-beam-hero.html'), '<html></html>');
    writeFileSync(path.join(experiment, 'attach-beam-hero-render.mjs'), 'script');

    const gitDir = path.join(repo, '.git');
    const scriptsDir = path.join(repo, 'scripts');
    const homeDir = path.join(scratch, 'home');
    const outParent = path.join(scratch, 'out-parent');
    const outDir = path.join(outParent, 'out');
    const emptyOutParent = path.join(scratch, 'empty-out-parent');
    const emptyOut = path.join(emptyOutParent, 'out');
    const emptyCopyParent = path.join(scratch, 'empty-copy-parent');
    const emptyCopy = path.join(emptyCopyParent, 'copy');
    const emptyDocs = path.join(repo, 'docs');
    const seedNames = ['keep.txt', 'frame-00000.jpg'];
    const seedDir = (dir) => {
      mkdirSync(dir, { recursive: true });
      for (const name of seedNames) writeFileSync(path.join(dir, name), `seed:${name}`);
    };
    seedDir(gitDir);
    seedDir(scriptsDir);
    seedDir(homeDir);
    seedDir(outParent);
    mkdirSync(outDir);
    mkdirSync(emptyOutParent);
    mkdirSync(emptyCopyParent);
    mkdirSync(emptyDocs);

    const base = { scriptDir: experiment, repoRoot: repo, cwd: repo, env: {} };
    const cases = [
      ['git', gitDir, ['--frames-dir', gitDir, '--out-dir', outDir]],
      ['git trailing slash', `${gitDir}${path.sep}`, ['--frames-dir', `${gitDir}${path.sep}`, '--out-dir', outDir]],
      ['scripts', scriptsDir, ['--frames-dir', scriptsDir, '--out-dir', outDir]],
      ['scripts trailing slash', `${scriptsDir}${path.sep}`, ['--frames-dir', `${scriptsDir}${path.sep}`, '--out-dir', outDir]],
      ['home stand-in', homeDir, ['--frames-dir', homeDir, '--out-dir', outDir]],
      ['parent of out-dir', outParent, ['--frames-dir', outParent, '--out-dir', outDir]],
      ['parent of out-dir trailing slash', `${outParent}${path.sep}`, ['--frames-dir', `${outParent}${path.sep}`, '--out-dir', `${outDir}${path.sep}`]],
      ['empty parent of out-dir', emptyOutParent, ['--frames-dir', emptyOutParent, '--out-dir', emptyOut]],
      ['empty parent of copy-dir', emptyCopyParent, ['--frames-dir', emptyCopyParent, '--out-dir', outDir, '--copy-dir', emptyCopy]],
    ];

    for (const [name, framesDir, argv] of cases) {
      const before = readdirSync(framesDir).sort();
      const plan = buildAttachBeamPlan({ ...base, argv });
      expect(() => assertSafeFramesDir({ ...plan, framesDir }), name).toThrow(/Refusing to wipe/);
      await expect(runAttachBeam({
        ...base,
        argv,
        loadPlaywright: async () => {
          throw new Error(`playwright should not load (${name})`);
        },
        captureFrames: async () => {
          throw new Error(`capture should not run (${name})`);
        },
      }), name).rejects.toThrow(/Refusing to wipe/);
      expect(readdirSync(framesDir).sort(), name).toEqual(before);
      for (const fileName of seedNames) {
        if (!before.includes(fileName)) continue;
        expect(readFileSync(path.join(framesDir, fileName), 'utf8'), `${name}:${fileName}`).toBe(`seed:${fileName}`);
      }
    }

    const linkDir = (target, link) => {
      try {
        symlinkSync(target, link, 'dir');
        return true;
      } catch {
        try {
          symlinkSync(target, link, 'junction');
          return true;
        } catch {
          return false;
        }
      }
    };
    const docsLink = path.join(scratch, 'docs-link');
    if (linkDir(emptyDocs, docsLink)) {
      const plan = buildAttachBeamPlan({ ...base, argv: ['--frames-dir', docsLink, '--out-dir', outDir] });
      expect(() => assertSafeFramesDir(plan)).toThrow(/Refusing to wipe/);
      expect(readdirSync(emptyDocs)).toEqual([]);
      expect(existsSync(docsLink)).toBe(true);
    } else if (process.platform !== 'win32') {
      throw new Error('expected to create a directory symlink');
    }
    const parentLink = path.join(scratch, 'parent-link');
    if (linkDir(emptyOutParent, parentLink)) {
      const framesDir = `${parentLink}${path.sep}`;
      const plan = buildAttachBeamPlan({ ...base, argv: ['--frames-dir', emptyOut, '--out-dir', emptyOut] });
      expect(() => assertSafeFramesDir({ ...plan, framesDir, outDir: emptyOut, copyDir: null })).toThrow(/Refusing to wipe/);
      expect(readdirSync(emptyOutParent)).toEqual([]);
    }
    const outLink = path.join(scratch, 'out-link');
    const copyLink = path.join(scratch, 'copy-link');
    if (linkDir(emptyOut, outLink) && linkDir(emptyCopy, copyLink)) {
      const viaLinks = buildAttachBeamPlan({
        ...base,
        argv: ['--frames-dir', `${emptyOutParent}${path.sep}`, '--out-dir', `${outLink}${path.sep}`, '--copy-dir', copyLink],
      });
      expect(() => assertSafeFramesDir(viaLinks)).toThrow(/ancestor of the output directory/);
      const viaCopy = buildAttachBeamPlan({
        ...base,
        argv: ['--frames-dir', emptyCopyParent, '--out-dir', outDir, '--copy-dir', `${copyLink}${path.sep}`],
      });
      expect(() => assertSafeFramesDir(viaCopy)).toThrow(/ancestor of the copy directory/);
      expect(readdirSync(emptyOutParent)).toEqual([]);
      expect(readdirSync(emptyCopyParent)).toEqual([]);
    }

    writeFileSync(path.join(gitDir, FRAMES_MARKER), FRAMES_MARKER_TEXT);
    const markedGit = readdirSync(gitDir).sort();
    const markedPlan = buildAttachBeamPlan({ ...base, argv: ['--frames-dir', gitDir, '--out-dir', outDir] });
    await expect(prepareFramesDir(markedPlan)).rejects.toThrow(/Refusing to wipe/);
    expect(readdirSync(gitDir).sort()).toEqual(markedGit);
    expect(readFileSync(path.join(gitDir, 'frame-00000.jpg'), 'utf8')).toBe('seed:frame-00000.jpg');

    const defaultFrames = path.join(repo, '.attach-beam-frames');
    mkdirSync(defaultFrames);
    const allowed = buildAttachBeamPlan({
      ...base,
      argv: ['--frames-dir', `${defaultFrames}${path.sep}`, '--out-dir', outDir],
    });
    expect(() => assertSafeFramesDir(allowed)).not.toThrow();
    const defaultLink = path.join(scratch, 'default-link');
    if (linkDir(defaultFrames, defaultLink)) {
      expect(() => assertSafeFramesDir({ ...allowed, framesDir: defaultLink })).not.toThrow();
      rmSync(defaultLink);
    }
    rmSync(defaultFrames, { recursive: true });
    const skillsDir = path.join(repo, 'skills');
    mkdirSync(skillsDir);
    if (linkDir(skillsDir, defaultFrames)) {
      expect(() => assertSafeFramesDir({ ...allowed, framesDir: defaultFrames })).toThrow(/Refusing to wipe/);
      expect(readdirSync(skillsDir)).toEqual([]);
    }
  });

  it('deletes only frame-#####.jpg files in a directory this script marked', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'attach-beam-clean-'));
    const repo = path.join(scratch, 'repo');
    const experiment = path.join(repo, 'experiment');
    const frames = path.join(scratch, 'frames');
    const outDir = path.join(scratch, 'out');
    mkdirSync(experiment, { recursive: true });
    mkdirSync(frames);
    writeFileSync(path.join(experiment, 'attach-beam-hero.html'), '<html></html>');
    const plan = buildAttachBeamPlan({
      scriptDir: experiment,
      repoRoot: repo,
      cwd: scratch,
      env: {},
      argv: ['--frames-dir', frames, '--out-dir', outDir],
    });

    writeFileSync(path.join(frames, 'notes.txt'), 'notes');
    writeFileSync(path.join(frames, 'frame-00000.jpg'), 'old');
    await expect(prepareFramesDir(plan)).rejects.toThrow(/Refusing to wipe/);
    expect(readFileSync(path.join(frames, 'notes.txt'), 'utf8')).toBe('notes');
    expect(readFileSync(path.join(frames, 'frame-00000.jpg'), 'utf8')).toBe('old');
    expect(existsSync(path.join(frames, FRAMES_MARKER))).toBe(false);

    writeFileSync(path.join(frames, FRAMES_MARKER), 'not-from-this-script\n');
    await expect(prepareFramesDir(plan)).rejects.toThrow(/Refusing to wipe/);
    expect(readFileSync(path.join(frames, 'frame-00000.jpg'), 'utf8')).toBe('old');

    writeFileSync(path.join(frames, FRAMES_MARKER), FRAMES_MARKER_TEXT);
    writeFileSync(path.join(frames, 'frame-0000.jpg'), 'short');
    writeFileSync(path.join(frames, 'frame-00000.png'), 'png');
    mkdirSync(path.join(frames, 'nested'));
    writeFileSync(path.join(frames, 'nested', 'frame-00000.jpg'), 'nested');
    await prepareFramesDir(plan);
    expect(existsSync(frames)).toBe(true);
    expect(existsSync(path.join(frames, 'frame-00000.jpg'))).toBe(false);
    expect(readFileSync(path.join(frames, 'notes.txt'), 'utf8')).toBe('notes');
    expect(readFileSync(path.join(frames, 'frame-0000.jpg'), 'utf8')).toBe('short');
    expect(readFileSync(path.join(frames, 'frame-00000.png'), 'utf8')).toBe('png');
    expect(readFileSync(path.join(frames, 'nested', 'frame-00000.jpg'), 'utf8')).toBe('nested');
    expect(readFileSync(path.join(frames, FRAMES_MARKER), 'utf8')).toBe(FRAMES_MARKER_TEXT);
  });
});
