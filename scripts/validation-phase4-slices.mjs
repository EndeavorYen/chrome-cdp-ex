#!/usr/bin/env node

import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { relative, resolve, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { withLiveBenchmarkLock } from './benchmark-run-lock.mjs';
import {
  assertLiveBoundary,
  buildDisposableBrowserArgs,
  discoverBrowserCandidates,
} from './validation-live-boundary.mjs';
import { redactEvidence } from './lib/validation-lab.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const cdpPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const pagePath = resolve(rootDir, 'scripts/smoke-page.html');
const serverPath = resolve(rootDir, 'scripts/validation-loopback-server.mjs');
const EXPECTED_TITLE = 'chrome-cdp-ex long-session smoke';
const ACTION_PARITY_COMMANDS = new Set([
  'back', 'clickxy', 'clock', 'dismiss-modal', 'emulate', 'fill', 'forward', 'hover', 'jsclick',
  'dialog', 'keepalive', 'mock', 'nav', 'netlog', 'press', 'reload', 'scroll', 'select',
  'console', 'inject', 'restore', 'throttle', 'type', 'upload', 'verify-click', 'viewport',
  'shot', 'diff-shot', 'elshot', 'fullshot', 'scanshot',
  'qa', 'responsive-audit',
]);
const SEMANTIC_PARITY_COMMANDS = new Set(['record']);
const ACTION_STATE_EXPRESSION = "({title:document.title,modalHidden:document.querySelector('#motd')?.hidden===true,shortcut:document.querySelector('#shortcut-status')?.textContent,inputValue:document.querySelector('#cmd')?.value,selectValue:document.querySelector('#phase7-select')?.value,scrollY:Math.round(window.scrollY),jsStatus:document.querySelector('#phase7-js-status')?.textContent,coordStatus:document.querySelector('#phase7-coord-status')?.textContent,authState:document.querySelector('#auth-state')?.textContent})";
const RELOAD_STATE_EXPRESSION = "JSON.stringify({url:location.href,loadCount:Number(/^phase7-load:(\\d+)$/.exec(window.name)?.[1]),marker:document.querySelector('#phase7-load-generation')?.textContent})";
const BOUND_SCANSHOT_EXPRESSION = `(() => {
  const body = document.body;
  const main = document.querySelector('main');
  const spacer = document.querySelector('main > div[aria-hidden="true"]');
  const root = document.documentElement;
  if (!body || !main || !spacer || globalThis.__phase7ScanshotFixture) {
    throw new Error('scanshot fixture boundary is unavailable');
  }
  globalThis.__phase7ScanshotFixture = {
    bodyMinHeight: body.style.minHeight,
    mainMaxHeight: main.style.maxHeight,
    mainHeight: main.style.height,
    mainOverflow: main.style.overflow,
    spacerDisplay: spacer.style.display,
    scrollBehavior: root.style.scrollBehavior,
  };
  body.style.minHeight = '0';
  main.style.height = Math.ceil(window.innerHeight * 1.8) + 'px';
  main.style.maxHeight = main.style.height;
  main.style.overflow = 'hidden';
  spacer.style.display = 'none';
  root.style.scrollBehavior = 'auto';
  window.scrollTo(0, 0);
  return JSON.stringify({
    mode: 'bounded',
    scrollHeight: root.scrollHeight,
    viewportHeight: window.innerHeight,
  });
})()`;
const RESTORE_SCANSHOT_EXPRESSION = `(() => {
  const body = document.body;
  const main = document.querySelector('main');
  const spacer = document.querySelector('main > div[aria-hidden="true"]');
  const root = document.documentElement;
  const saved = globalThis.__phase7ScanshotFixture;
  if (!body || !main || !spacer || !saved) throw new Error('scanshot fixture state is unavailable');
  body.style.minHeight = saved.bodyMinHeight;
  main.style.maxHeight = saved.mainMaxHeight;
  main.style.height = saved.mainHeight;
  main.style.overflow = saved.mainOverflow;
  spacer.style.display = saved.spacerDisplay;
  root.style.scrollBehavior = saved.scrollBehavior;
  delete globalThis.__phase7ScanshotFixture;
  return JSON.stringify({
    mode: 'restored',
    scrollHeight: root.scrollHeight,
    viewportHeight: window.innerHeight,
  });
})()`;

export function phase4RuntimeBase({ platform = process.platform, tempDir = tmpdir() } = {}) {
  return platform === 'win32' ? tempDir : '/tmp';
}

function scanshotSegmentCount(scrollHeight, viewportHeight) {
  const overlap = Math.round(viewportHeight * 0.1);
  const step = viewportHeight - overlap;
  const segments = [];
  for (let y = 0; y < scrollHeight; y += step) segments.push(y);
  if (segments.length > 1) {
    const lastY = segments[segments.length - 1];
    if (scrollHeight - lastY < viewportHeight * 0.3) {
      segments.pop();
      const bottomY = Math.max(0, scrollHeight - viewportHeight);
      if (bottomY > segments[segments.length - 1]) segments.push(bottomY);
    }
  }
  return segments.length;
}

export function assertPhase4ScanshotBoundary(raw, expectedMode) {
  let value;
  try { value = JSON.parse(raw); } catch { value = null; }
  if (!exactKeys(value, ['mode', 'scrollHeight', 'viewportHeight'])
    || value.mode !== expectedMode
    || !Number.isInteger(value.scrollHeight) || value.scrollHeight < 1
    || !Number.isInteger(value.viewportHeight) || value.viewportHeight < 1) {
    throw new Error('scanshot boundary state is invalid');
  }
  const segments = scanshotSegmentCount(value.scrollHeight, value.viewportHeight);
  if ((expectedMode === 'bounded' && (segments < 2 || segments > 3))
    || (expectedMode === 'restored' && segments < 4)) {
    throw new Error('scanshot boundary did not preserve the intended segment range');
  }
  return segments;
}

export async function withPhase4ScanshotFixture({ evaluate, execute } = {}) {
  if (typeof evaluate !== 'function' || typeof execute !== 'function') {
    throw new Error('scanshot fixture requires evaluate and execute');
  }
  const prepared = evaluate(BOUND_SCANSHOT_EXPRESSION);
  let result;
  let primaryError = null;
  try {
    assertPhase4ScanshotBoundary(prepared, 'bounded');
    result = await execute();
  } catch (error) {
    primaryError = error;
  }
  let restoreError = null;
  try {
    assertPhase4ScanshotBoundary(evaluate(RESTORE_SCANSHOT_EXPRESSION), 'restored');
  } catch (error) {
    restoreError = error;
  }
  if (primaryError && restoreError) {
    throw new AggregateError([primaryError, restoreError], primaryError.message);
  }
  if (primaryError) throw primaryError;
  if (restoreError) throw restoreError;
  return result;
}

function immutableCommand(id, args) {
  return Object.freeze({ id, args: Object.freeze(args) });
}

export function assertPhase4TargetReady(model, url, expectedTitle = EXPECTED_TITLE) {
  const observation = assertLiveBoundary(model, url);
  const page = model.pages.find(entry => entry?.url === url);
  if (page?.title !== expectedTitle) throw new Error('disposable loopback page is not ready');
  if (!observation.targetPrefix) throw new Error('disposable target prefix is missing');
  return { ...observation, title: page.title, targetId: page.targetId || null };
}

export function buildPhase4SliceCommands(
  targetPrefix,
  navigationUrl = 'http://127.0.0.1:41758/validation-phase4.html#phase7-navigation',
  {
    uploadPath = 'phase7-upload.txt',
    restorePath = 'phase7-checkpoint.json',
    shotPath = 'phase7-shot.png',
    fullshotPath = 'phase7-fullshot.png',
    responsiveOutDir = 'phase7-responsive-audit',
    includeScreenshots = false,
    includeQa = false,
  } = {},
) {
  if (typeof targetPrefix !== 'string' || !/^[A-Za-z0-9]{4,64}$/.test(targetPrefix)) {
    throw new Error('targetPrefix must be a bounded target identifier');
  }
  if (typeof navigationUrl !== 'string'
    || !/^http:\/\/127\.0\.0\.1:\d+\/validation-phase4\.html(?:\?route=mcp)?#phase7-navigation$/.test(navigationUrl)) {
    throw new Error('navigationUrl must be the bounded loopback navigation fixture');
  }
  for (const [name, value] of Object.entries({ uploadPath, restorePath, shotPath, fullshotPath, responsiveOutDir })) {
    if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 4096) {
      throw new Error(`${name} must be a bounded file path`);
    }
  }
  return Object.freeze([
    immutableCommand('perceive', ['perceive', targetPrefix, '--format', 'json']),
    immutableCommand('click', ['click', targetPrefix, '#close-modal', '--format', 'json']),
    immutableCommand('report', ['report', targetPrefix, '--qa', '--format', 'json']),
    immutableCommand('html', ['html', targetPrefix, '#auth-state']),
    immutableCommand('text', ['text', targetPrefix, '#auth-state']),
    immutableCommand('table', ['table', targetPrefix, '#missing-table']),
    immutableCommand('net', ['net', targetPrefix]),
    immutableCommand('status', ['status', targetPrefix, '--format', 'json']),
    immutableCommand('summary', ['summary', targetPrefix, '--format', 'json']),
    immutableCommand('snap', ['snap', targetPrefix]),
    immutableCommand('controls', [
      'controls', targetPrefix, '--selector', 'main', '--filter', 'command input',
      '--limit', '5', '--compact', '--format', 'json',
    ]),
    immutableCommand('frame', ['frame', targetPrefix, '--format', 'json']),
    immutableCommand('overlay', ['overlay', targetPrefix, '--format', 'json']),
    immutableCommand('styles', ['styles', targetPrefix, '#auth-panel']),
    immutableCommand('components', ['components', targetPrefix, '--format', 'json']),
    immutableCommand('record-actions', ['record-actions', targetPrefix, '--format', 'json']),
    immutableCommand('export-playwright', [
      'export-playwright', targetPrefix, '--title', 'Phase 7 fixture', '--format', 'json',
    ]),
    immutableCommand('wait', ['wait', targetPrefix, '25']),
    immutableCommand('waitfor', ['waitfor', targetPrefix, '#auth-state', '1000']),
    immutableCommand('cascade', [
      'cascade', targetPrefix, '#auth-panel', 'padding-top', '--format', 'json',
    ]),
    immutableCommand('checkpoint', ['checkpoint', targetPrefix]),
    immutableCommand('cookies', ['cookies', targetPrefix]),
    immutableCommand('verify-click', [
      'verify-click', targetPrefix, '#refresh-account', '--expect-text', 'auth state preserved after refresh', '--format', 'json',
    ]),
    immutableCommand('fill', ['fill', targetPrefix, '#cmd', 'phase7 input', '--format', 'json']),
    immutableCommand('type', ['type', targetPrefix, ' +typed', '--format', 'json']),
    immutableCommand('hover', ['hover', targetPrefix, '#refresh-account']),
    immutableCommand('scroll', ['scroll', targetPrefix, 'down', '100', '--format', 'json']),
    immutableCommand('select', ['select', targetPrefix, '#phase7-select', 'two', '--format', 'json']),
    immutableCommand('jsclick', ['jsclick', targetPrefix, '#phase7-reopen', '--format', 'json']),
    immutableCommand('dismiss-modal', ['dismiss-modal', targetPrefix, '--format', 'json']),
    immutableCommand('clickxy', ['clickxy', targetPrefix, '64', '322', '--format', 'json']),
    immutableCommand('press', ['press', targetPrefix, 'c', '--format', 'json']),
    immutableCommand('evalraw', [
      'evalraw',
      targetPrefix,
      'Runtime.evaluate',
      JSON.stringify({
        expression: ACTION_STATE_EXPRESSION,
        returnByValue: true,
      }),
    ]),
    immutableCommand('eval', ['eval', targetPrefix, '"phase7-eval"']),
    immutableCommand('eval64', [
      'eval64', targetPrefix, Buffer.from('"多語"', 'utf8').toString('base64'),
    ]),
    immutableCommand('call', [
      'call', targetPrefix, 'async () => ({ phase7: "call" })',
    ]),
    immutableCommand('console', ['console', targetPrefix, '--clear']),
    immutableCommand('record', ['record', targetPrefix, '100']),
    immutableCommand('batch', [
      'batch', targetPrefix, 'text #auth-state | wait 25', '--compact',
    ]),
    immutableCommand('flow', [
      'flow', targetPrefix, 'text #auth-state; assert text "auth state preserved after refresh"',
    ]),
    immutableCommand('repeat', ['repeat', targetPrefix, '2', 'wait', '25']),
    immutableCommand('replay', [
      'replay', targetPrefix, '--format', 'json', '--json', JSON.stringify({
        schema: 'chrome-cdp-ex.record-actions.v1',
        actions: [{
          index: 1, action: 'wait', command: ['wait', '25'], replayable: true, needsInput: [],
        }],
      }),
    ]),
    immutableCommand('upload', [
      'upload', targetPrefix, '#upload-file', uploadPath, '--format', 'json',
    ]),
    ...(includeScreenshots ? [
      immutableCommand('shot', ['shot', targetPrefix, shotPath, '--quiet']),
      immutableCommand('elshot', ['elshot', targetPrefix, '#auth-panel']),
      immutableCommand('fullshot', ['fullshot', targetPrefix, fullshotPath]),
      immutableCommand('diff-shot', ['diff-shot', targetPrefix, '--reset', '--format', 'json']),
    ] : []),
    immutableCommand('inject', [
      'inject', targetPrefix, '--css', '#auth-panel { outline: 7px solid rgb(1, 2, 3); }', '--format', 'json',
    ]),
    ...(includeScreenshots ? [
      immutableCommand('diff-shot', ['diff-shot', targetPrefix, '--keep-baseline', '--format', 'json']),
    ] : []),
    immutableCommand('restore', [
      'restore', targetPrefix, '--file', restorePath, '--format', 'json',
    ]),
    immutableCommand('cookieset', ['cookieset', targetPrefix, 'phase7_mutation=fixture']),
    immutableCommand('cookiedel', ['cookiedel', targetPrefix, 'phase7_mutation']),
    immutableCommand('dialog', ['dialog', targetPrefix, 'dismiss']),
    immutableCommand('keepalive', ['keepalive', targetPrefix, '1000']),
    immutableCommand('netlog', ['netlog', targetPrefix, '--clear']),
    immutableCommand('nav', ['nav', targetPrefix, navigationUrl, '--format', 'json']),
    immutableCommand('back', ['back', targetPrefix, '--format', 'json']),
    immutableCommand('forward', ['forward', targetPrefix, '--format', 'json']),
    immutableCommand('reload', ['reload', targetPrefix, '--format', 'json']),
    immutableCommand('mock', [
      'mock', targetPrefix, 'add', '**/api/mock', '--status', '201',
      '--body', 'fixture-mock', '--content-type', 'text/plain', '--format', 'json',
    ]),
    immutableCommand('throttle', ['throttle', targetPrefix, 'fast-3g', '--format', 'json']),
    immutableCommand('clock', [
      'clock', targetPrefix, 'freeze', '--at', '2020-01-02T03:04:05.000Z', '--format', 'json',
    ]),
    immutableCommand('viewport', ['viewport', targetPrefix, '390x844', '--format', 'json']),
    immutableCommand('emulate', [
      'emulate', targetPrefix, 'dark', 'reduced-motion', 'reduce', '--format', 'json',
    ]),
    ...(includeQa ? [
      immutableCommand('qa', [
        'qa', targetPrefix, '--desktop', '800x600', '--mobile', '390x844',
        '--expect-text', 'auth state preserved', '--format', 'json',
      ]),
      immutableCommand('responsive-audit', [
        'responsive-audit', targetPrefix, '--viewport', '800x600', '--out-dir', responsiveOutDir,
        '--max-controls', '5', '--format', 'json',
      ]),
    ] : []),
    ...(includeScreenshots ? [
      immutableCommand('scanshot', ['scanshot', targetPrefix]),
    ] : []),
  ]);
}

export function assertPhase4NavigationState(id, actualUrl, { baseUrl, navigationUrl }) {
  const expected = {
    nav: navigationUrl,
    back: baseUrl,
    forward: navigationUrl,
    reload: navigationUrl,
  }[id];
  if (!expected || actualUrl !== expected) {
    throw new Error(`${id} navigation state is invalid`);
  }
  return actualUrl;
}

export function assertPhase4ReloadState(value, { navigationUrl }) {
  if (!exactKeys(value, ['url', 'loadCount', 'marker'])
    || value.url !== navigationUrl
    || value.loadCount !== 2
    || value.marker !== 'load:2') {
    throw new Error('reload generation state is invalid');
  }
  return value.loadCount;
}

export function assertPhase4EnvironmentEffect(id, raw) {
  if (id === 'mock') {
    let value;
    try { value = JSON.parse(raw); } catch { value = null; }
    if (!exactKeys(value, ['status', 'body']) || value.status !== 201 || value.body !== 'fixture-mock') {
      throw new Error('mock live effect is invalid');
    }
    return value.status;
  }
  if (id === 'clock') {
    if (Number(raw) !== 1_577_934_245_000) throw new Error('clock live effect is invalid');
    return Number(raw);
  }
  if (id === 'throttle') {
    let value;
    try { value = JSON.parse(raw); } catch { value = null; }
    const durationMs = value?.durationMs;
    if (!exactKeys(value, ['durationMs', 'status', 'body'])
      || value.status !== 200 || value.body !== 'throttle-ok'
      || !Number.isFinite(durationMs) || durationMs < 100 || durationMs > 5_000) {
      throw new Error(`throttle live effect is invalid: ${String(raw).slice(0, 80)}`);
    }
    return durationMs;
  }
  throw new Error(`unknown environment effect ${id}`);
}

export function assertPhase4RenderingEffect(id, raw) {
  let value;
  try { value = JSON.parse(raw); } catch { value = null; }
  if (id === 'viewport') {
    if (!exactKeys(value, ['width', 'height', 'dpr'])
      || value.width !== 390 || value.height !== 844
      || !Number.isFinite(value.dpr) || value.dpr <= 0 || value.dpr > 8) {
      throw new Error(`viewport live effect is invalid: ${String(raw).slice(0, 160)}`);
    }
    return '390x844';
  }
  if (id === 'emulate') {
    if (!exactKeys(value, ['dark', 'reducedMotion'])
      || value.dark !== true || value.reducedMotion !== true) {
      throw new Error(`emulate live effect is invalid: ${String(raw).slice(0, 160)}`);
    }
    return 'dark+reduce';
  }
  throw new Error(`unknown rendering effect ${id}`);
}

export function buildPhase4CookieEffectCommand(id, targetPrefix) {
  if (!['cookieset', 'cookiedel'].includes(id)) throw new Error(`unknown cookie effect ${id}`);
  const found = "document.cookie.split('; ').includes('phase7_mutation=fixture')";
  return ['eval', targetPrefix, id === 'cookieset' ? found : `!(${found})`];
}

export function assertPhase4CookieEffect(id, raw) {
  if (!['cookieset', 'cookiedel'].includes(id) || raw !== 'true') {
    throw new Error(`${id} cookie effect is invalid`);
  }
  return true;
}

export function buildPhase4ExternalInputEffectCommand(id, targetPrefix) {
  const expressions = {
    upload: "JSON.stringify({name:document.querySelector('#upload-file')?.files?.[0]?.name||null,status:document.querySelector('#upload-status')?.textContent||null})",
    inject: "JSON.stringify({count:document.querySelectorAll('[data-cdp-inject]').length,outlineWidth:getComputedStyle(document.querySelector('#auth-panel')).outlineWidth})",
    restore: "JSON.stringify({url:location.href,theme:localStorage.getItem('theme'),phase:sessionStorage.getItem('phase')})",
  };
  if (!Object.hasOwn(expressions, id)) throw new Error(`unknown external-input effect ${id}`);
  return ['eval', targetPrefix, expressions[id]];
}

export function assertPhase4ExternalInputEffect(id, raw, { expectedUrl } = {}) {
  let value;
  try { value = JSON.parse(raw); } catch { value = null; }
  if (id === 'upload') {
    if (!exactKeys(value, ['name', 'status'])
      || value.name !== 'phase7-upload.txt' || value.status !== 'upload:phase7-upload.txt') {
      throw new Error(`upload live effect is invalid: ${String(raw).slice(0, 160)}`);
    }
    return value.name;
  }
  if (id === 'inject') {
    if (!exactKeys(value, ['count', 'outlineWidth']) || value.count !== 1 || value.outlineWidth !== '7px') {
      throw new Error(`inject live effect is invalid: ${String(raw).slice(0, 160)}`);
    }
    return value.count;
  }
  if (id === 'restore') {
    if (!exactKeys(value, ['url', 'theme', 'phase']) || value.url !== expectedUrl
      || value.theme !== 'phase7-restored' || value.phase !== 'phase7-restored') {
      throw new Error(`restore live effect is invalid: ${String(raw).slice(0, 160)}`);
    }
    return value.theme;
  }
  throw new Error(`unknown external-input effect ${id}`);
}

export function assertPhase4InjectionRemoved(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { value = null; }
  if (!exactKeys(value, ['count']) || value.count !== 0) throw new Error('inject removal effect is invalid');
  return true;
}

function environmentEffectExpression(id) {
  if (id === 'mock') {
    return "fetch('/api/mock').then(async response => JSON.stringify({status:response.status,body:await response.text()}))";
  }
  if (id === 'clock') return 'Date.now()';
  return "async function(){const start=performance.now();const response=await fetch('/api/throttle-probe?phase7=1',{cache:'no-store'});return {durationMs:Math.round(performance.now()-start),status:response.status,body:await response.text()}}";
}

function environmentEffectCommand(id, targetPrefix) {
  return [id === 'throttle' ? 'call' : 'eval', targetPrefix, environmentEffectExpression(id)];
}

export function buildPhase4RenderingEffectCommand(id, targetPrefix) {
  const expression = id === 'viewport'
    ? 'JSON.stringify({width:Math.round(visualViewport.width),height:Math.round(visualViewport.height),dpr:devicePixelRatio})'
    : "JSON.stringify({dark:matchMedia('(prefers-color-scheme: dark)').matches,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches})";
  return ['eval', targetPrefix, expression];
}

function parseStepJson(id, stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${id} output is not valid JSON`);
  }
}

function exactKeys(value, expected) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function finiteNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export function assertPhase4ActionState(fixtureState, { expectedTitle, modalHidden }) {
  if (!fixtureState
    || typeof fixtureState !== 'object'
    || Array.isArray(fixtureState)
    || Object.keys(fixtureState).sort().join(',') !== 'authState,coordStatus,inputValue,jsStatus,modalHidden,scrollY,selectValue,shortcut,title'
    || fixtureState.title !== expectedTitle
    || fixtureState.modalHidden !== modalHidden
    || fixtureState.shortcut !== 'shortcut:c'
    || fixtureState.inputValue !== 'phase7 input +typed'
    || fixtureState.selectValue !== 'two'
    || fixtureState.jsStatus !== 'jsclick:reopened'
    || fixtureState.coordStatus !== 'clickxy:clicked'
    || fixtureState.authState !== 'auth state preserved after refresh'
    || !finiteNonNegativeInteger(fixtureState.scrollY)
    || fixtureState.scrollY < 1) {
    throw new Error(`action fixture state is invalid: ${JSON.stringify(fixtureState).slice(0, 1200)}`);
  }
  return fixtureState.title;
}

const ALLOWED_IDENTITY_KEYS = new Set([
  'targetId', 'sessionId', 'requestedTargetId', 'boundTargetId', 'resolvedTargetId',
]);

function validOpaqueIdentity(key, value) {
  if (key === 'sessionId') return typeof value === 'string' && /^[A-F0-9]{16,64}$/i.test(value);
  return typeof value === 'string' && /^[A-F0-9]{12,64}$/i.test(value);
}

function privacyProjection(value) {
  if (Array.isArray(value)) return value.map(privacyProjection);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (ALLOWED_IDENTITY_KEYS.has(key)) {
      if (!validOpaqueIdentity(key, child)) {
        throw new Error(`output identity ${key} is not a bounded opaque identifier`);
      }
      return [key, '<redacted>'];
    }
    return [key, privacyProjection(child)];
  }));
}

function projectAllowedArtifactPaths(value, allowedPaths) {
  if (typeof value === 'string') {
    return allowedPaths.reduce((output, allowed) => output.split(allowed).join('<task-artifact>'), value);
  }
  if (Array.isArray(value)) return value.map(child => projectAllowedArtifactPaths(child, allowedPaths));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key, projectAllowedArtifactPaths(child, allowedPaths),
  ]));
}

export function assertPhase4OutputPrivacy(id, stdout, { allowedPaths = [] } = {}) {
  if (typeof stdout !== 'string') throw new Error(`${id} output must be a string`);
  let projected = stdout;
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  if (parsed !== null) projected = privacyProjection(parsed);
  projected = projectAllowedArtifactPaths(projected, allowedPaths);
  const redacted = redactEvidence(projected, {
    homeDirs: [userInfo().homedir],
    tempDirs: [tmpdir()],
    paths: [rootDir],
  }).value;
  if (JSON.stringify(redacted) !== JSON.stringify(projected)) {
    throw new Error(`${id} output contains credential-bearing or machine-local material`);
  }
  return stdout;
}

function assertPrivatePngArtifact(path, artifactRoot) {
  if (typeof path !== 'string' || typeof artifactRoot !== 'string') throw new Error('screenshot artifact path is invalid');
  const root = resolve(artifactRoot);
  const absolute = resolve(path);
  const child = relative(root, absolute);
  if (!child || child.startsWith(`..${sep}`) || child === '..') throw new Error('screenshot artifact escaped task runtime');
  const stat = statSync(absolute);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('screenshot artifact is not a private file');
  const signature = readFileSync(absolute).subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error('screenshot artifact is not PNG');
  return absolute;
}

function validQaPageUrl(value) {
  return typeof value === 'string'
    && /^http:\/\/127\.0\.0\.1:\d+\/validation-phase4\.html(?:\?route=mcp)?#phase7-navigation$/.test(value);
}

export function assertPhase4QaFilesystem(model, { targetPrefix, expectedTitle, artifactRoot } = {}) {
  if (!exactKeys(model, [
    'schema', 'targetId', 'targetPrefix', 'page', 'pageHealth', 'console', 'perception',
    'screenshots', 'action', 'assertions', 'errors', 'checks', 'verdict', 'nextSteps',
    'targetResolution',
  ])
    || model.schema !== 'chrome-cdp-ex.qa-page.v1'
    || !validActionTargetResolution(model.targetResolution, targetPrefix)
    || model.targetId !== model.targetResolution.requestedTargetId
    || model.targetPrefix !== model.targetId.slice(0, 8)
    || !exactKeys(model.page, ['title', 'url'])
    || model.page.title !== expectedTitle || !validQaPageUrl(model.page.url)
    || model.pageHealth?.isBlank !== false || model.pageHealth?.status !== 'populated'
    || !exactKeys(model.console, ['errors', 'warnings', 'exceptions'])
    || model.console.errors !== 0 || model.console.exceptions !== 0
    || model.perception?.captured !== true
    || model.action !== null
    || !Array.isArray(model.assertions) || model.assertions.length !== 1
    || model.assertions[0]?.kind !== 'text' || model.assertions[0]?.status !== 'pass'
    || !Array.isArray(model.errors) || model.errors.length !== 0
    || !exactKeys(model.checks, [
      'page', 'console', 'desktopScreenshot', 'mobileScreenshot', 'assertions', 'action',
    ])
    || model.checks.page !== 'pass' || model.checks.console !== 'pass'
    || model.checks.desktopScreenshot !== 'pass' || model.checks.mobileScreenshot !== 'pass'
    || model.checks.assertions !== 'pass' || model.checks.action !== 'skip'
    || model.verdict !== 'pass'
    || !Array.isArray(model.nextSteps) || model.nextSteps.length !== 2) {
    throw new Error(`qa fixture output is invalid: ${JSON.stringify(model).slice(0, 1600)}`);
  }
  const expectedScreenshots = { desktop: '800x600', mobile: '390x844' };
  if (!exactKeys(model.screenshots, Object.keys(expectedScreenshots))) {
    throw new Error('qa screenshot inventory is invalid');
  }
  for (const [name, viewport] of Object.entries(expectedScreenshots)) {
    const screenshot = model.screenshots[name];
    if (!exactKeys(screenshot, ['viewport', 'path']) || screenshot.viewport !== viewport) {
      throw new Error(`qa ${name} screenshot metadata is invalid`);
    }
    assertPrivatePngArtifact(screenshot.path, artifactRoot);
  }
  return model.verdict;
}

export function assertPhase4ResponsiveFilesystem(model, { targetPrefix, expectedTitle, artifactRoot } = {}) {
  if (!exactKeys(model, [
    'schema', 'targetId', 'targetPrefix', 'page', 'console', 'viewports', 'errors',
    'verdict', 'summary', 'nextSteps', 'targetResolution',
  ])
    || model.schema !== 'chrome-cdp-ex.responsive-audit.v1'
    || !validActionTargetResolution(model.targetResolution, targetPrefix)
    || model.targetId !== model.targetResolution.requestedTargetId
    || model.targetPrefix !== model.targetId.slice(0, 8)
    || !exactKeys(model.page, ['title', 'url'])
    || model.page.title !== expectedTitle || !validQaPageUrl(model.page.url)
    || !exactKeys(model.console, ['errors', 'warnings', 'exceptions'])
    || model.console.errors !== 0 || model.console.exceptions !== 0
    || !Array.isArray(model.viewports) || model.viewports.length !== 1
    || !Array.isArray(model.errors) || model.errors.length !== 0
    || !['pass', 'warn'].includes(model.verdict)
    || !exactKeys(model.summary, ['pass', 'warn', 'fail'])
    || model.summary.fail !== 0 || model.summary.pass + model.summary.warn !== 1
    || !Array.isArray(model.nextSteps) || model.nextSteps.length !== 3) {
    throw new Error(`responsive-audit fixture output is invalid: ${JSON.stringify(model).slice(0, 1600)}`);
  }
  const viewport = model.viewports[0];
  if (viewport?.viewport !== '800x600'
    || viewport.status !== model.verdict
    || viewport.url !== model.page.url
    || viewport.title !== expectedTitle
    || viewport.pageHealth?.isBlank !== false
    || viewport.pageHealth?.status !== 'populated'
    || !Number.isInteger(viewport.controlCount) || viewport.controlCount < 1
    || !Array.isArray(viewport.controls) || viewport.controls.length > 5
    || !viewport.findings || !Array.isArray(viewport.findings.clippedControls)
    || !Array.isArray(viewport.findings.overlaps)
    || viewport.error !== null) {
    throw new Error(`responsive-audit viewport output is invalid: ${JSON.stringify(viewport).slice(0, 1600)}`);
  }
  assertPrivatePngArtifact(viewport.screenshot, artifactRoot);
  return model.verdict;
}

function validTargetResolution(value, targetPrefix, targetId) {
  return exactKeys(value, [
    'requestedTargetPrefix', 'requestedTargetId', 'boundTargetId',
    'resolvedTargetId', 'resolutionSource', 'status', 'rebound',
  ])
    && value.requestedTargetPrefix === targetPrefix
    && typeof targetId === 'string'
    && targetId.startsWith(targetPrefix)
    && value.requestedTargetId === targetId
    && value.boundTargetId === targetId
    && value.resolvedTargetId === targetId
    && value.resolutionSource === 'live-discovery'
    && ['started', 'reused'].includes(value.status)
    && value.rebound === false;
}

function validActionTargetResolution(value, targetPrefix) {
  if (!exactKeys(value, [
    'requestedTargetPrefix', 'requestedTargetId', 'boundTargetId',
    'resolvedTargetId', 'resolutionSource', 'status', 'rebound',
  ])) return false;
  const targetId = value.requestedTargetId;
  const requestMatches = value.requestedTargetPrefix === targetPrefix
    ? typeof targetId === 'string' && targetId.startsWith(targetPrefix)
    : value.requestedTargetPrefix === targetId;
  return requestMatches
    && typeof targetId === 'string' && /^[A-F0-9]{12,64}$/i.test(targetId)
    && value.boundTargetId === targetId
    && value.resolvedTargetId === targetId
    && value.resolutionSource === 'live-discovery'
    && ['started', 'reused'].includes(value.status)
    && value.rebound === false;
}

function validateStep(id, stdout, {
  targetPrefix,
  expectedTitle,
  expectedUrl,
  expectedSessionIdentity = null,
  artifactRoot = null,
}) {
  assertPhase4OutputPrivacy(id, stdout, { allowedPaths: artifactRoot ? [artifactRoot] : [] });
  const expectedExtraction = {
    html: '<p id="auth-state">auth state preserved</p>',
    text: 'auth state preserved',
    table: 'No tables found matching #missing-table',
  };
  if (Object.hasOwn(expectedExtraction, id)) {
    if (stdout !== expectedExtraction[id]) throw new Error(`${id} fixture output is invalid`);
    return stdout;
  }
  if (id === 'net') {
    if (stdout !== '') throw new Error(`net fixture output is invalid: ${JSON.stringify(stdout.slice(0, 240))}`);
    return stdout;
  }
  if (id === 'wait') {
    if (stdout !== 'Waited 25ms') throw new Error(`wait fixture output is invalid: ${JSON.stringify(stdout)}`);
    return stdout;
  }
  if (id === 'waitfor') {
    if (stdout !== 'Found <P> "auth state preserved"') {
      throw new Error(`waitfor fixture output is invalid: ${JSON.stringify(stdout)}`);
    }
    return stdout;
  }
  if (id === 'hover') {
    if (!/^Hovering over <BUTTON> at CSS \(\d+, \d+\)$/.test(stdout)) {
      throw new Error(`hover fixture output is invalid: ${JSON.stringify(stdout)}`);
    }
    return stdout;
  }
  if (id === 'cookieset') {
    if (stdout !== 'Cookie set: phase7_mutation=fixture (domain: 127.0.0.1)') {
      throw new Error(`cookieset fixture output is invalid: ${JSON.stringify(stdout)}`);
    }
    return stdout;
  }
  if (id === 'cookiedel') {
    if (stdout !== 'Cookie deleted: phase7_mutation') throw new Error(`cookiedel fixture output is invalid: ${JSON.stringify(stdout)}`);
    return stdout;
  }
  if (id === 'dialog') {
    if (stdout !== 'Dialog auto-accept: OFF (dialogs will be dismissed/rejected)') {
      throw new Error(`dialog fixture output is invalid: ${JSON.stringify(stdout)}`);
    }
    return stdout;
  }
  if (id === 'keepalive') {
    if (!/^Daemon keepalive extended for 1000ms \(until \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\)$/.test(stdout)) {
      throw new Error(`keepalive fixture output is invalid: ${JSON.stringify(stdout)}`);
    }
    return stdout;
  }
  if (id === 'netlog') {
    if (stdout !== 'Network log cleared') throw new Error(`netlog fixture output is invalid: ${JSON.stringify(stdout)}`);
    return stdout;
  }
  if (id === 'shot') return assertPrivatePngArtifact(stdout.split('\n')[0], artifactRoot);
  if (id === 'elshot') {
    const lines = stdout.split('\n');
    if (!stdout.slice(lines[0].length + 1).startsWith('Element screenshot of <SECTION>#auth-panel')) {
      throw new Error(`elshot fixture output is invalid: ${JSON.stringify(stdout)}`);
    }
    return assertPrivatePngArtifact(lines[0], artifactRoot);
  }
  if (id === 'fullshot') {
    const lines = stdout.split('\n');
    if (lines.length !== 3 || !lines[1].startsWith('Full-page screenshot saved. Size: ')) {
      throw new Error(`fullshot fixture output is invalid: ${JSON.stringify(stdout)}`);
    }
    return assertPrivatePngArtifact(lines[0], artifactRoot);
  }
  if (id === 'scanshot') {
    const paths = stdout.split('\n').filter(line => /^ {2}\[\d+\/\d+\] /.test(line)).map(line => line.replace(/^ {2}\[\d+\/\d+\] /, ''));
    if (!/^Captured \d+ segment\(s\)/.test(stdout) || paths.length < 1) {
      throw new Error(`scanshot fixture output is invalid: ${JSON.stringify(stdout)}`);
    }
    paths.forEach(path => assertPrivatePngArtifact(path, artifactRoot));
    return paths.length;
  }
  if (id === 'eval') {
    if (stdout !== 'phase7-eval') throw new Error(`eval fixture output is invalid: ${JSON.stringify(stdout)}`);
    return stdout;
  }
  if (id === 'eval64') {
    if (stdout !== '多語') throw new Error(`eval64 fixture output is invalid: ${JSON.stringify(stdout)}`);
    return stdout;
  }
  if (id === 'call') {
    if (stdout !== '{\n  "phase7": "call"\n}') throw new Error(`call fixture output is invalid: ${JSON.stringify(stdout)}`);
    return stdout;
  }
  if (id === 'console') {
    if (stdout !== 'Console baseline cleared (console and exception buffers)') {
      throw new Error(`console fixture output is invalid: ${JSON.stringify(stdout)}`);
    }
    return stdout;
  }
  if (id === 'record') {
    const lines = stdout.split('\n');
    if (!/^Record timeline \(\d+ms\)$/.test(lines[0] || '')
      || lines.length < 2 || !lines.slice(1).every(line => line.trim().length > 0)) {
      throw new Error(`record fixture output is invalid: ${JSON.stringify(stdout.slice(0, 1200))}`);
    }
    return 'recorded click';
  }
  if (id === 'batch') {
    if (stdout !== '[1] text: auth state preserved after refresh\n[2] wait: Waited 25ms') {
      throw new Error(`batch fixture output is invalid: ${JSON.stringify(stdout)}`);
    }
    return stdout;
  }
  if (id === 'flow') {
    const expected = [
      'Flow: 2 step(s)',
      '[1/2] text #auth-state',
      '  auth state preserved after refresh',
      '[2/2] assert text includes "auth state preserved after refresh"',
      '  Assertion passed: text includes "auth state preserved after refresh"',
    ].join('\n');
    if (stdout !== expected) throw new Error(`flow fixture output is invalid: ${JSON.stringify(stdout)}`);
    return stdout;
  }
  if (id === 'repeat') {
    const expected = [
      'Repeat 2× wait 25',
      '[1/2] ok: Waited 25ms',
      '[2/2] ok: Waited 25ms',
      'Done: 2 ok, 0 failed',
    ].join('\n');
    if (stdout !== expected) throw new Error(`repeat fixture output is invalid: ${JSON.stringify(stdout)}`);
    return stdout;
  }
  if (id === 'replay') {
    const model = parseStepJson(id, stdout);
    if (!exactKeys(model, [
      'schema', 'source', 'sourceTargetId', 'sourceSessionId', 'continueOnError',
      'halted', 'counts', 'steps', 'failedStep', 'nextSteps', 'targetResolution',
    ]) || model.schema !== 'chrome-cdp-ex.replay.v1'
      || model.source !== 'inline JSON' || model.sourceTargetId !== null || model.sourceSessionId !== null
      || model.continueOnError !== false || model.halted !== false
      || !exactKeys(model.counts, ['environment', 'actions', 'total', 'ok', 'failed', 'skipped'])
      || model.counts.environment !== 0 || model.counts.actions !== 1 || model.counts.total !== 1
      || model.counts.ok !== 1 || model.counts.failed !== 0 || model.counts.skipped !== 0
      || !Array.isArray(model.steps) || model.steps.length !== 1
      || model.steps[0]?.phase !== 'action' || model.steps[0]?.commandText !== 'wait 25'
      || model.steps[0]?.ok !== true || model.steps[0]?.skipped !== false
      || model.failedStep !== null || !Array.isArray(model.nextSteps) || model.nextSteps.length !== 0
      || !validTargetResolution(model.targetResolution, targetPrefix, model.targetResolution?.requestedTargetId)) {
      throw new Error(`replay fixture output is invalid: ${JSON.stringify(model).slice(0, 1200)}`);
    }
    return 'replayed wait';
  }
  if (id === 'checkpoint') {
    const expected = [
      'Checkpoint captured',
      `URL: ${expectedUrl}`,
      'Privacy: default-redacted',
      'Storage: local 2, session 1',
      'Cookies: 1',
      'Values: cookie values and sensitive storage values are redacted by default.',
      'Next: use `checkpoint --unsafe-full --format json` only when restore fidelity is required.',
    ].join('\n');
    if (stdout !== expected) throw new Error(`checkpoint fixture output is invalid: ${JSON.stringify(stdout)}`);
    return stdout;
  }
  if (id === 'cookies') {
    const lines = stdout.split('\n');
    if (lines.length !== 1
      || !/^phase7_fixture\s+fixture-value\s+127\.0\.0\.1\s+session\s+Lax$/.test(lines[0].trim())) {
      throw new Error(`cookies fixture output is invalid: ${JSON.stringify(stdout)}`);
    }
    return stdout;
  }
  if (id === 'snap') {
    if (typeof stdout !== 'string'
      || !stdout.includes(`[RootWebArea] ${expectedTitle}`)
      || !stdout.includes('[button] Refresh account')
      || !stdout.endsWith('it is the recommended starting command.)')) {
      throw new Error('snap fixture output is invalid');
    }
    return expectedTitle;
  }
  if (id === 'styles') {
    if (typeof stdout !== 'string'
      || !stdout.startsWith('<SECTION>#auth-panel\n')
      || !stdout.includes('\n  background-color: rgb(240, 253, 244)')
      || !stdout.includes('\n  padding: 12px')
      || !stdout.includes('\n  border: 1px solid rgb(187, 247, 208)')) {
      throw new Error(`styles fixture output is invalid: ${JSON.stringify(stdout.slice(0, 1000))}`);
    }
    return '<SECTION>#auth-panel';
  }
  const model = parseStepJson(id, stdout);
  if (id === 'qa') {
    return assertPhase4QaFilesystem(model, { targetPrefix, expectedTitle, artifactRoot });
  }
  if (id === 'responsive-audit') {
    return assertPhase4ResponsiveFilesystem(model, { targetPrefix, expectedTitle, artifactRoot });
  }
  if (id === 'diff-shot') {
    if (model?.schema !== 'chrome-cdp-ex.diff-shot.v1'
      || typeof model.targetId !== 'string' || !/^[A-F0-9]{12,64}$/i.test(model.targetId)
      || model.targetId !== model.targetResolution?.requestedTargetId
      || !validActionTargetResolution(model.targetResolution, targetPrefix)) {
      throw new Error(`diff-shot fixture output is invalid: ${JSON.stringify(model).slice(0, 1200)}`);
    }
    assertPrivatePngArtifact(model.baselinePath, artifactRoot);
    if (model.baselineCaptured === true) {
      if (model.currentPath !== model.baselinePath || model.diffPath !== null
        || model.changedPixels !== 0 || model.totalPixels !== 0) {
        throw new Error('diff-shot baseline state is invalid');
      }
      return 'baseline';
    }
    assertPrivatePngArtifact(model.currentPath, artifactRoot);
    assertPrivatePngArtifact(model.diffPath, artifactRoot);
    if (model.baselineCaptured !== false || !Number.isInteger(model.changedPixels)
      || model.changedPixels < 1 || !Number.isInteger(model.totalPixels)
      || model.totalPixels < model.changedPixels || model.advancedBaseline !== false) {
      throw new Error('diff-shot comparison state is invalid');
    }
    return 'diff';
  }
  if (id === 'cascade') {
    const property = model.properties?.[0];
    const rule = property?.rules?.[0];
    const source = property?.winner?.source;
    if (!exactKeys(model, [
      'schema', 'input', 'propertyCount', 'properties', 'inherited', 'editTarget', 'recommendation',
      'targetResolution',
    ])
      || model.schema !== 'chrome-cdp-ex.cascade.v1'
      || !exactKeys(model.input, ['selector', 'property'])
      || model.input.selector !== '#auth-panel' || model.input.property !== 'padding-top'
      || model.propertyCount !== 1
      || !Array.isArray(model.properties) || model.properties.length !== 1
      || !exactKeys(property, ['name', 'computedValue', 'winner', 'rules'])
      || property.name !== 'padding-top' || property.computedValue !== '12px'
      || !exactKeys(property.winner, ['selector', 'value', 'source', 'origin'])
      || property.winner.selector !== '#auth-panel' || property.winner.value !== '12px'
      || property.winner.origin !== 'regular'
      || typeof source !== 'string' || !/^chrome-cdp-ex-smoke\.css:\d+$/.test(source)
      || !Array.isArray(property.rules) || property.rules.length !== 1
      || !exactKeys(rule, ['selector', 'value', 'source', 'origin', 'winner', 'overridden'])
      || rule.selector !== '#auth-panel' || rule.value !== '12px' || rule.source !== source
      || rule.origin !== 'regular' || rule.winner !== true || rule.overridden !== false
      || !Array.isArray(model.inherited) || model.inherited.length !== 0
      || !exactKeys(model.editTarget, ['property', 'selector', 'value', 'source', 'origin'])
      || model.editTarget.property !== 'padding-top' || model.editTarget.selector !== '#auth-panel'
      || model.editTarget.value !== '12px' || model.editTarget.source !== source
      || model.editTarget.origin !== 'regular'
      || !exactKeys(model.recommendation, ['source', 'strategy', 'property', 'selector', 'sourceLocation'])
      || model.recommendation.source !== 'cascade'
      || model.recommendation.strategy !== 'edit-winning-source'
      || model.recommendation.property !== 'padding-top'
      || model.recommendation.selector !== '#auth-panel'
      || model.recommendation.sourceLocation !== source
      || !validTargetResolution(model.targetResolution, targetPrefix, model.targetResolution?.requestedTargetId)) {
      throw new Error(`cascade fixture output is invalid: ${JSON.stringify(model).slice(0, 1600)}`);
    }
    return model.schema;
  }
  if (id === 'overlay') {
    if (!exactKeys(model, ['schema', 'viewport', 'target', 'overlayCount', 'blocking', 'overlays', 'nextCommand', 'targetResolution'])
      || model.schema !== 'chrome-cdp-ex.overlays.v1'
      || !exactKeys(model.viewport, ['width', 'height'])
      || !Number.isInteger(model.viewport.width) || model.viewport.width < 1
      || !Number.isInteger(model.viewport.height) || model.viewport.height < 1
      || model.target !== null
      || model.overlayCount !== 0
      || model.blocking !== false
      || !Array.isArray(model.overlays) || model.overlays.length !== 0
      || model.nextCommand !== null
      || !validTargetResolution(model.targetResolution, targetPrefix, model.targetResolution?.requestedTargetId)) {
      throw new Error(`overlay fixture output is invalid: ${JSON.stringify(model).slice(0, 1200)}`);
    }
    return model.schema;
  }
  if (id === 'components') {
    if (!exactKeys(model, ['schema', 'framework', 'ok', 'message', 'targetResolution'])
      || model.schema !== 'chrome-cdp-ex.components.v1'
      || model.framework !== null
      || model.ok !== false
      || model.message !== 'No supported framework detected (React fiber/DevTools, Vue, or Angular ng-version).'
      || !validTargetResolution(model.targetResolution, targetPrefix, model.targetResolution?.requestedTargetId)) {
      throw new Error(`components fixture output is invalid: ${JSON.stringify(model).slice(0, 1200)}`);
    }
    return model.schema;
  }
  if (id === 'record-actions') {
    const action = model.actions?.[0];
    if (!exactKeys(model, ['schema', 'targetId', 'sessionId', 'source', 'environmentCount', 'environment', 'actionCount', 'actions', 'targetResolution'])
      || model.schema !== 'chrome-cdp-ex.record-actions.v1'
      || typeof model.targetId !== 'string' || !model.targetId.startsWith(targetPrefix)
      || typeof model.sessionId !== 'string' || model.sessionId.length < 1
      || model.source !== 'session-action-log'
      || model.environmentCount !== 0
      || !Array.isArray(model.environment) || model.environment.length !== 0
      || model.actionCount !== 1
      || !Array.isArray(model.actions) || model.actions.length !== 1
      || !exactKeys(action, ['index', 'ts', 'action', 'target', 'command', 'replayable', 'needsInput', 'evidence'])
      || action.index !== 1
      || !Number.isFinite(action.ts)
      || action.action !== 'click'
      || JSON.stringify(action.command) !== JSON.stringify(['click', '#close-modal'])
      || action.replayable !== true
      || !Array.isArray(action.needsInput) || action.needsInput.length !== 0
      || action.target?.input !== '#close-modal'
      || !validTargetResolution(model.targetResolution, targetPrefix, model.targetId)) {
      throw new Error(`record-actions fixture output is invalid: ${JSON.stringify(model).slice(0, 1600)}`);
    }
    return { schema: model.schema, targetId: model.targetId, sessionId: model.sessionId };
  }
  if (id === 'export-playwright') {
    if (!exactKeys(model, ['schema', 'targetId', 'sessionId', 'source', 'title', 'counts', 'spec', 'review', 'nextSteps', 'targetResolution'])
      || model.schema !== 'chrome-cdp-ex.export-playwright.v1'
      || typeof model.targetId !== 'string' || !model.targetId.startsWith(targetPrefix)
      || typeof model.sessionId !== 'string' || model.sessionId.length < 1
      || model.source !== 'record-actions'
      || model.title !== 'Phase 7 fixture'
      || !exactKeys(model.counts, ['environment', 'environmentExported', 'environmentSkipped', 'actions', 'actionsExported', 'actionsSkipped', 'assertions'])
      || model.counts.environment !== 0
      || model.counts.environmentExported !== 0
      || model.counts.environmentSkipped !== 0
      || model.counts.actions !== 1
      || model.counts.actionsExported !== 1
      || model.counts.actionsSkipped !== 0
      || !Number.isInteger(model.counts.assertions) || model.counts.assertions < 0
      || typeof model.spec !== 'string'
      || !model.spec.includes("test('Phase 7 fixture', async ({ page }) => {")
      || !model.spec.includes('await page.locator("#close-modal").click();')
      || !Array.isArray(model.review) || model.review.length !== 0
      || !Array.isArray(model.nextSteps) || model.nextSteps.length !== 2
      || !validTargetResolution(model.targetResolution, targetPrefix, model.targetId)
      || !expectedSessionIdentity
      || model.targetId !== expectedSessionIdentity.targetId
      || model.sessionId !== expectedSessionIdentity.sessionId) {
      throw new Error(`export-playwright fixture output is invalid: ${JSON.stringify(model).slice(0, 1800)}`);
    }
    return model.schema;
  }
  if (id === 'controls') {
    if (!exactKeys(model, ['schema', 'scope', 'filter', 'limit', 'total', 'returned', 'truncated', 'controls', 'compact', 'targetResolution'])
      || model.schema !== 'chrome-cdp-ex.visible-controls.v1'
      || model.scope !== 'main'
      || model.filter !== 'command input'
      || model.limit !== 5
      || model.total !== 1
      || model.returned !== 1
      || model.truncated !== false
      || model.compact !== true
      || !Array.isArray(model.controls) || model.controls.length !== 1
      || !exactKeys(model.controls[0], ['role', 'label', 'selector', 'disabled', 'clickable', 'rect'])
      || model.controls[0].role !== 'textbox'
      || model.controls[0].label !== 'command input'
      || model.controls[0].selector !== 'input#cmd'
      || model.controls[0].disabled !== false
      || model.controls[0].clickable !== true
      || !validTargetResolution(model.targetResolution, targetPrefix, model.targetResolution?.requestedTargetId)) {
      throw new Error(`controls fixture output is invalid: ${JSON.stringify(model).slice(0, 1200)}`);
    }
    return model.schema;
  }
  if (id === 'frame') {
    if (!exactKeys(model, ['schema', 'frameCount', 'frames', 'targetResolution'])
      || model.schema !== 'chrome-cdp-ex.frames.v1'
      || model.frameCount !== 2
      || !Array.isArray(model.frames) || model.frames.length !== 2
      || model.frames[0]?.ref !== '@f1'
      || model.frames[0]?.depth !== 0
      || model.frames[0]?.url !== expectedUrl
      || model.frames[1]?.ref !== '@f2'
      || model.frames[1]?.parentRef !== '@f1'
      || model.frames[1]?.depth !== 1
      || model.frames[1]?.url !== 'about:srcdoc'
      || !validTargetResolution(model.targetResolution, targetPrefix, model.targetResolution?.requestedTargetId)) {
      throw new Error(`frame fixture output is invalid: ${JSON.stringify(model).slice(0, 1200)}`);
    }
    return model.schema;
  }
  if (id === 'status') {
    if (!exactKeys(model, ['schema', 'targetId', 'target', 'page', 'console', 'exceptions', 'navigation', 'runtime', 'targetResolution'])
      || model.schema !== 'chrome-cdp-ex.status.v1'
      || typeof model.targetId !== 'string'
      || !model.targetId.startsWith(targetPrefix)
      || !exactKeys(model.target, ['state', 'diagnostic'])
      || model.target.state !== 'connected'
      || model.target.diagnostic !== null
      || !exactKeys(model.page, ['title', 'url'])
      || model.page.title !== expectedTitle
      || model.page.url !== expectedUrl
      || !Array.isArray(model.console) || model.console.length !== 0
      || !Array.isArray(model.exceptions) || model.exceptions.length !== 0
      || !Array.isArray(model.navigation) || model.navigation.length !== 0
      || model.runtime !== null
      || !validTargetResolution(model.targetResolution, targetPrefix, model.targetId)) {
      throw new Error(`status fixture output is invalid: ${JSON.stringify(model).slice(0, 1000)}`);
    }
    return model.schema;
  }
  if (id === 'summary') {
    if (!exactKeys(model, ['schema', 'page', 'viewport', 'interactive', 'counts', 'limits', 'focused', 'console', 'targetResolution'])
      || model.schema !== 'chrome-cdp-ex.summary.v1'
      || !exactKeys(model.page, ['title', 'url'])
      || model.page.title !== expectedTitle
      || model.page.url !== expectedUrl
      || !exactKeys(model.viewport, ['size', 'scrollY', 'scrollMax'])
      || typeof model.viewport.size !== 'string'
      || !/^\d+x\d+$/.test(model.viewport.size)
      || !finiteNonNegativeInteger(model.viewport.scrollY)
      || !finiteNonNegativeInteger(model.viewport.scrollMax)
      || !exactKeys(model.interactive, Object.keys(model.interactive || {}))
      || Object.values(model.interactive).some(value => !finiteNonNegativeInteger(value))
      || !exactKeys(model.counts, ['domNodes', 'tableRows', 'visibleControls', 'hiddenTemplateNodes'])
      || model.counts.domNodes < 1
      || !Object.values(model.counts).every(finiteNonNegativeInteger)
      || !exactKeys(model.limits, ['outputTokenBudget', 'hiddenTemplateNodesOmitted', 'truncated'])
      || model.limits.outputTokenBudget !== 1200
      || model.limits.hiddenTemplateNodesOmitted !== model.counts.hiddenTemplateNodes
      || typeof model.limits.truncated !== 'boolean'
      || typeof model.focused !== 'string'
      || !exactKeys(model.console, ['errors', 'warnings', 'exceptions'])
      || !Object.values(model.console).every(finiteNonNegativeInteger)
      || !validTargetResolution(model.targetResolution, targetPrefix, model.targetResolution?.requestedTargetId)) {
      throw new Error(`summary fixture output is invalid: ${JSON.stringify(model).slice(0, 1000)}`);
    }
    return model.schema;
  }
  if (id === 'perceive') {
    if (model?.schema !== 'chrome-cdp-ex.perceive.v1') throw new Error('perceive schema is invalid');
    if (model?.targetPrefix !== targetPrefix) throw new Error('perceive target is invalid');
    if (model?.page?.title !== expectedTitle) {
      throw new Error(`perceive title is invalid: ${JSON.stringify(String(model?.page?.title ?? '').slice(0, 120))}`);
    }
    return null;
  }
  if (['back', 'click', 'clickxy', 'dismiss-modal', 'fill', 'forward', 'inject', 'jsclick', 'nav', 'press', 'reload', 'restore', 'scroll', 'select', 'type', 'upload', 'viewport'].includes(id)) {
    if (model?.schema !== 'chrome-cdp-ex.action.v1' || model?.action !== id) {
      throw new Error(`${id} schema is invalid`);
    }
    if (model?.receipt?.schema !== 'chrome-cdp-ex.action-receipt.v1') {
      throw new Error(`${id} receipt schema is invalid`);
    }
    if (model?.dispatch?.ok !== true) {
      throw new Error(`${id} dispatch is invalid: ${JSON.stringify(model).slice(0, 1600)}`);
    }
    const outcome = model.receipt.outcome || model?.outcome?.status;
    const allowedOutcomes = id === 'click' ? ['changed', 'dispatched'] : ['changed', 'dispatched', 'no-change'];
    if (!allowedOutcomes.includes(outcome)) {
      throw new Error(`${id} outcome is invalid: ${JSON.stringify({ outcome, model }).slice(0, 1600)}`);
    }
    if (['inject', 'restore', 'upload'].includes(id)) {
      const expectedArgs = {
        restore: ['--file', '[checkpoint-path-redacted]'],
        upload: ['#upload-file', '<redacted>'],
      }[id];
      const commandArgsValid = id === 'inject'
        ? [['--css', '<redacted>'], ['--remove']]
          .some(args => JSON.stringify(model?.target?.commandArgs) === JSON.stringify(args))
        : JSON.stringify(model?.target?.commandArgs) === JSON.stringify(expectedArgs);
      if (!commandArgsValid
        || !Array.isArray(model?.target?.redacted) || !model.target.redacted.includes('commandArgs')
        || !validActionTargetResolution(model.targetResolution, targetPrefix)) {
        throw new Error(`${id} privacy or target binding is invalid: ${JSON.stringify(model).slice(0, 1600)}`);
      }
    }
    return outcome;
  }
  if (id === 'verify-click') {
    const assertion = model?.assertions?.[0];
    if (!exactKeys(model, [
      'schema', 'action', 'target', 'dispatch', 'settlement', 'outcome',
      'verdict', 'assertions', 'matchedRequest', 'actionEvidence', 'targetResolution',
    ])
      || model.schema !== 'chrome-cdp-ex.semantic-interaction.v1'
      || model.action !== 'click'
      || model.target !== '#refresh-account'
      || model.dispatch?.ok !== true
      || model.verdict !== 'pass'
      || !Array.isArray(model.assertions) || model.assertions.length !== 1
      || assertion?.kind !== 'text'
      || assertion?.expected !== 'auth state preserved after refresh'
      || assertion?.status !== 'pass'
      || model.matchedRequest !== null
      || model.actionEvidence !== null
      || !validActionTargetResolution(model.targetResolution, targetPrefix)) {
      throw new Error(`verify-click fixture output is invalid: ${JSON.stringify(model).slice(0, 1600)}`);
    }
    return model.outcome;
  }
  if (id === 'mock') {
    if (model?.schema !== 'chrome-cdp-ex.mock.v1' || model?.mode !== 'add'
      || !Array.isArray(model.rules) || model.rules.length !== 1
      || model.rules[0]?.urlPattern !== '**/api/mock' || model.rules[0]?.status !== 201) {
      throw new Error(`mock fixture output is invalid: ${JSON.stringify(model).slice(0, 1200)}`);
    }
    return model.schema;
  }
  if (id === 'clock') {
    if (model?.schema !== 'chrome-cdp-ex.clock.v1' || model?.mode !== 'apply'
      || model.profile !== 'freeze' || model.atMs !== 1_577_934_245_000) {
      throw new Error(`clock fixture output is invalid: ${JSON.stringify(model).slice(0, 1200)}`);
    }
    return model.schema;
  }
  if (id === 'throttle') {
    if (model?.schema !== 'chrome-cdp-ex.throttle.v1' || model?.mode !== 'apply'
      || model.profile !== 'fast-3g' || model.offline !== false
      || model.latencyMs !== 150 || model.downloadKbps !== 1600 || model.uploadKbps !== 750) {
      throw new Error(`throttle fixture output is invalid: ${JSON.stringify(model).slice(0, 1200)}`);
    }
    return model.schema;
  }
  if (id === 'emulate') {
    if (!exactKeys(model, [
      'schema', 'targetPrefix', 'colorScheme', 'reducedMotion', 'features',
      'active', 'nextCommand', 'targetResolution',
    ])
      || model.schema !== 'chrome-cdp-ex.emulate.v1'
      || typeof model.targetPrefix !== 'string' || !/^[A-F0-9]{4,64}$/i.test(model.targetPrefix)
      || model.colorScheme !== 'dark' || model.reducedMotion !== 'reduce'
      || JSON.stringify(model.features) !== JSON.stringify([
        { name: 'prefers-color-scheme', value: 'dark' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ])
      || model.active !== true
      || model.nextCommand !== `cdp perceive ${model.targetPrefix} -C -d 8`
      || !validActionTargetResolution(model.targetResolution, targetPrefix)) {
      throw new Error(`emulate fixture output is invalid: ${JSON.stringify(model).slice(0, 1200)}`);
    }
    return model.schema;
  }
  if (id === 'report') {
    if (model?.schema !== 'chrome-cdp-ex.qa-summary.v1' || model?.source !== 'report') {
      throw new Error('report schema is invalid');
    }
    if (model?.targetPrefix !== targetPrefix) throw new Error('report target is invalid');
    if (model?.report?.schema !== 'chrome-cdp-ex.report.v1'
      || !Number.isInteger(model?.report?.counts?.actions) || model.report.counts.actions < 1) {
      throw new Error('report action count is invalid');
    }
    if (model?.report?.latestAction?.action !== 'click') throw new Error('report action is invalid');
    if (model.report.latestAction.status !== 'ok'
      || !['changed', 'dispatched'].includes(model.report.latestAction.outcomeStatus)) {
      throw new Error(`report action state is invalid: ${JSON.stringify(model).slice(0, 1600)}`);
    }
    return model.report.counts.actions;
  }
  const fixtureState = model?.result?.value;
  if (model?.result?.type !== 'object') {
    throw new Error('evalraw fixture state is invalid');
  }
  try {
    return assertPhase4ActionState(fixtureState, { expectedTitle, modalHidden: true });
  } catch {
    throw new Error('evalraw fixture state is invalid');
  }
}

export async function runPhase4SliceSession({
  targetPrefix,
  expectedTitle = EXPECTED_TITLE,
  expectedUrl,
  navigationUrl = 'http://127.0.0.1:41758/validation-phase4.html#phase7-navigation',
  uploadPath = 'phase7-upload.txt',
  restorePath = 'phase7-checkpoint.json',
  shotPath = 'phase7-shot.png',
  fullshotPath = 'phase7-fullshot.png',
  responsiveOutDir = 'phase7-responsive-audit',
  artifactRoot = null,
  runCommand,
  runMcpCommand,
  cleanup,
}) {
  if (typeof runCommand !== 'function') throw new Error('runCommand is required');
  if (typeof runMcpCommand !== 'function') throw new Error('runMcpCommand is required');
  if (typeof cleanup !== 'function') throw new Error('cleanup is required');
  let result;
  let primaryError = null;
  try {
    let clickOutcome = null;
    let reportActions = null;
    let title = null;
    let extractionParity = 0;
    let sessionIdentity = null;
    const commands = buildPhase4SliceCommands(targetPrefix, navigationUrl, {
      uploadPath,
      restorePath,
      shotPath,
      fullshotPath,
      responsiveOutDir,
      includeScreenshots: Boolean(artifactRoot),
      includeQa: Boolean(artifactRoot),
    });
    for (const command of commands) {
      let stdout;
      try {
        stdout = await runCommand(command);
      } catch (error) {
        throw new Error(`${command.id}: ${error.message}`, { cause: error });
      }
      const value = validateStep(command.id, stdout, {
        targetPrefix, expectedTitle, expectedUrl, expectedSessionIdentity: sessionIdentity, artifactRoot,
      });
      if (command.id === 'click') clickOutcome = value;
      if (command.id === 'report') reportActions = value;
      if (command.id === 'evalraw') title = value;
      if (command.id === 'record-actions') sessionIdentity = value;
      if (['html', 'text', 'table', 'net', 'status', 'summary', 'snap', 'controls', 'frame',
        'overlay', 'styles', 'components', 'record-actions', 'export-playwright',
        'wait', 'waitfor', 'cascade', 'checkpoint', 'cookies', 'console', 'record', 'dialog', 'keepalive', 'netlog',
        'press', 'fill', 'hover', 'inject', 'restore', 'scroll', 'select', 'upload',
        'back', 'clickxy', 'clock', 'dismiss-modal', 'forward', 'jsclick', 'mock', 'nav',
        'reload', 'throttle', 'type', 'verify-click', 'viewport', 'emulate',
        'shot', 'diff-shot', 'elshot', 'fullshot', 'scanshot', 'qa', 'responsive-audit'].includes(command.id)) {
        const mcpOutput = await runMcpCommand(command);
        if (!ACTION_PARITY_COMMANDS.has(command.id)
          && !SEMANTIC_PARITY_COMMANDS.has(command.id)
          && mcpOutput !== stdout) {
          throw new Error(`MCP ${command.id} output differs from CLI`);
        }
        validateStep(command.id, mcpOutput, {
          targetPrefix,
          expectedTitle,
          expectedUrl,
          expectedSessionIdentity: sessionIdentity,
          artifactRoot,
        });
        extractionParity += 1;
      }
    }
    result = {
      targetPrefix,
      commands: commands.map(command => command.id),
      title,
      clickOutcome,
      reportActions,
      extractionParity,
    };
  } catch (error) {
    primaryError = error;
  }

  try {
    await cleanup();
  } catch (cleanupError) {
    if (primaryError) throw new AggregateError([primaryError, cleanupError], primaryError.message);
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
  return result;
}

export function createPhase4Cancellation({ cleanup, exit }) {
  if (typeof cleanup !== 'function') throw new Error('cancellation cleanup is required');
  if (typeof exit !== 'function') throw new Error('cancellation exit is required');
  let cancelled = false;
  return Object.freeze({
    isCancelled: () => cancelled,
    ensureActive() {
      if (cancelled) throw new Error('Phase 4 core slices cancelled');
    },
    async onSignal(signal) {
      cancelled = true;
      try {
        await cleanup();
      } catch {
        // The owner path awaits the same memoized cleanup and preserves errors.
      } finally {
        exit(signal === 'SIGTERM' ? 143 : 130);
      }
    },
  });
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function stopBrowser(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 10 && child.exitCode === null && child.signalCode === null; attempt += 1) {
    await delay(50);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (let attempt = 0; attempt < 20 && child.exitCode === null && child.signalCode === null; attempt += 1) {
    await delay(50);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`disposable browser process ${child.pid} did not exit`);
  }
}

export function monitorDisposableBrowser(child, { maxBytes = 4096 } = {}) {
  if (!child || typeof child.once !== 'function' || !Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('browser diagnostic monitor requires a child and positive maxBytes');
  }
  let spawnError = null;
  let stderr = '';
  child.stderr?.on('data', chunk => {
    stderr = `${stderr}${chunk}`.slice(-maxBytes);
  });
  child.once('error', error => {
    spawnError = error;
  });
  return Object.freeze({
    error: () => spawnError,
    stderr: () => stderr,
  });
}

export function launchLoopbackFixtureServer({
  port,
  pagePath: fixturePath,
  spawnChild = spawn,
  stopChild = stopBrowser,
  sleep = delay,
} = {}) {
  const child = spawnChild(process.execPath, [serverPath, String(port), fixturePath], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const diagnostics = monitorDisposableBrowser(child);
  let stopping = null;
  const stop = () => {
    stopping ||= stopChild(child);
    return stopping;
  };
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-4096); });
  const ready = (async () => {
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (stdout.includes(`READY ${port}\n`)) return diagnostics;
        if (diagnostics.error()) throw diagnostics.error();
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`validation loopback server exited: ${diagnostics.stderr().trim() || child.exitCode || child.signalCode}`);
        }
        await sleep(25);
      }
      throw new Error('validation loopback server readiness timed out');
    } catch (error) {
      await stop().catch(() => {});
      throw error;
    }
  })();
  return Object.freeze({ child, ready, stop });
}

function spawnCdp(args, env, timeout = 30_000) {
  const child = spawnSync(process.execPath, [cdpPath, ...args], {
    cwd: rootDir,
    env,
    encoding: 'utf8',
    timeout,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`${args[0]} failed: ${child.stderr.trim() || `exit ${child.status}`}`);
  }
  return child.stdout.trim();
}

async function discoverDisposableTarget({ browser, diagnostics, port, url, env }) {
  let lastError = 'browser did not become reachable';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (diagnostics.error()) {
      throw new Error(`disposable browser launch failed: ${diagnostics.error().message}`);
    }
    if (browser.exitCode !== null || browser.signalCode !== null) {
      const detail = diagnostics.stderr().trim();
      throw new Error(`disposable browser exited ${browser.exitCode ?? browser.signalCode}${detail ? `: ${detail}` : ''}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (!response.ok) throw new Error(`CDP version endpoint returned ${response.status}`);
      const listed = JSON.parse(spawnCdp(['list', '--format', 'json'], env, 5_000));
      return assertPhase4TargetReady(listed, url, EXPECTED_TITLE);
    } catch (error) {
      lastError = error.message;
      await delay(150);
    }
  }
  throw new Error(`CDP_REACHABILITY: ${lastError}`);
}

export async function runDisposablePhase4Slices() {
  if (!existsSync(cdpPath) || !existsSync(pagePath)) throw new Error('Phase 4 validation fixtures are missing');
  const candidate = discoverBrowserCandidates()[0];
  if (!candidate) throw new Error('no Chrome for Testing browser binary found');
  const [browserPath, browserName] = candidate;

  return withLiveBenchmarkLock({
    name: 'validation-phase4-slices',
    portStart: 9354,
    serverPortStart: 41758,
    browser: browserName,
    profilePrefix: 'chrome-cdp-ex-validation-phase4',
  }, async run => {
    const { port, serverPort, profileDir } = run.metadata;
    const url = `http://127.0.0.1:${serverPort}/validation-phase4.html`;
    const mcpUrl = `${url}?route=mcp`;
    const navigationUrl = `${url}#phase7-navigation`;
    const mcpNavigationUrl = `${mcpUrl}#phase7-navigation`;
    const runtimeDir = mkdtempSync(resolve(phase4RuntimeBase(), 'chrome-cdp-p4-'));
    const localAppData = resolve(runtimeDir, 'localappdata');
    const uploadPath = resolve(runtimeDir, 'phase7-upload.txt');
    const restorePath = resolve(runtimeDir, 'phase7-checkpoint.json');
    const mcpRestorePath = resolve(runtimeDir, 'phase7-mcp-checkpoint.json');
    const shotPath = resolve(runtimeDir, 'phase7-shot.png');
    const mcpShotPath = resolve(runtimeDir, 'phase7-mcp-shot.png');
    const fullshotPath = resolve(runtimeDir, 'phase7-fullshot.png');
    const mcpFullshotPath = resolve(runtimeDir, 'phase7-mcp-fullshot.png');
    const responsiveOutDir = resolve(runtimeDir, 'phase7-responsive-audit');
    const mcpResponsiveOutDir = resolve(runtimeDir, 'phase7-mcp-responsive-audit');
    writeFileSync(uploadPath, 'phase7 upload fixture\n', { mode: 0o600 });
    const checkpointFor = pageUrl => JSON.stringify({
      schema: 'chrome-cdp-ex.checkpoint.v1',
      page: { url: pageUrl, title: EXPECTED_TITLE, origin: new URL(pageUrl).origin },
      storage: {
        localStorage: { theme: 'phase7-restored' },
        sessionStorage: { phase: 'phase7-restored' },
      },
      cookies: [],
    });
    writeFileSync(restorePath, checkpointFor(url), { mode: 0o600 });
    writeFileSync(mcpRestorePath, checkpointFor(mcpUrl), { mode: 0o600 });
    let server = null;
    let stopServer = null;
    let browser = null;
    let browserDiagnostics = null;
    let targetPrefix = null;
    let mcpTargetPrefix = null;
    let mcpTargetId = null;
    const targetPrefixes = new Set();
    let cleaning = null;
    const env = {
      ...process.env,
      CDP_PORT: String(port),
      NODE_ENV: 'production',
      XDG_RUNTIME_DIR: runtimeDir,
      ...(process.platform === 'win32' ? { LOCALAPPDATA: localAppData } : {}),
    };
    const previousPort = process.env.CDP_PORT;
    const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
    const previousLocalAppData = process.env.LOCALAPPDATA;
    process.env.CDP_PORT = String(port);
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    if (process.platform === 'win32') process.env.LOCALAPPDATA = localAppData;
    const cleanup = () => {
      cleaning ||= (async () => {
        const failures = [];
        for (const prefix of targetPrefixes) {
          try { spawnCdp(['stop', prefix], env, 5_000); } catch (error) { failures.push(error); }
        }
        const settled = await Promise.allSettled([
          stopBrowser(browser),
          stopServer ? stopServer() : stopBrowser(server),
        ]);
        for (const entry of settled) if (entry.status === 'rejected') failures.push(entry.reason);
        try {
          rmSync(profileDir, { recursive: true, force: true });
          if (existsSync(profileDir)) failures.push(new Error('disposable profile was not removed'));
        } catch (error) { failures.push(error); }
        try {
          rmSync(runtimeDir, { recursive: true, force: true });
          if (existsSync(runtimeDir)) failures.push(new Error('disposable runtime was not removed'));
        } catch (error) { failures.push(error); }
        if (previousPort === undefined) delete process.env.CDP_PORT;
        else process.env.CDP_PORT = previousPort;
        if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
        if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = previousLocalAppData;
        if (failures.length) throw new AggregateError(failures, 'Phase 4 cleanup failed');
      })();
      return cleaning;
    };
    const cancellation = createPhase4Cancellation({ cleanup, exit: code => { process.exitCode = code; } });
    const ensureActive = () => cancellation.ensureActive();
    const runCdp = (...args) => {
      ensureActive();
      const output = spawnCdp(...args);
      ensureActive();
      return output;
    };
    const onSignal = signal => { void cancellation.onSignal(signal); };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    try {
      ensureActive();
      const launchedServer = launchLoopbackFixtureServer({ port: serverPort, pagePath });
      server = launchedServer.child;
      stopServer = launchedServer.stop;
      await launchedServer.ready;
      ensureActive();
      browser = spawn(browserPath, buildDisposableBrowserArgs({ port, profileDir, url }), {
        detached: false,
        env: { ...process.env, HOME: userInfo().homedir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      ensureActive();
      browserDiagnostics = monitorDisposableBrowser(browser);
      const observation = await discoverDisposableTarget({
        browser,
        diagnostics: browserDiagnostics,
        port,
        url,
        env,
      });
      ensureActive();
      targetPrefix = observation.targetPrefix;
      targetPrefixes.add(targetPrefix);
      const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(mcpUrl)}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(2_000),
      });
      if (!created.ok) throw new Error(`independent MCP target creation returned ${created.status}`);
      const createdTarget = await created.json();
      if (typeof createdTarget?.id !== 'string' || createdTarget.id.length < 12) {
        throw new Error('independent MCP target creation returned no target identity');
      }
      const mcpObservation = await discoverDisposableTarget({
        browser,
        diagnostics: browserDiagnostics,
        port,
        url: mcpUrl,
        env,
      });
      if (mcpObservation.targetId !== createdTarget.id) {
        throw new Error('independent MCP target identity changed before attachment');
      }
      mcpTargetPrefix = mcpObservation.targetPrefix;
      mcpTargetId = mcpObservation.targetId;
      if (mcpTargetPrefix === targetPrefix) throw new Error('independent MCP action target is not distinct');
      targetPrefixes.add(mcpTargetPrefix);
      const { executeCdpCli } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
      const { createRuntimeClient } = await import('../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs');
      const { createMcpRequestHandler } = await import('../skills/chrome-cdp-ex/scripts/mcp-server.mjs');
      const sent = [];
      const mcpHandler = createMcpRequestHandler({
        runtimeClient: createRuntimeClient({ executeCli: command => executeCdpCli(command) }),
        sendMessage: message => sent.push(message),
      });
      const mcpActionHandler = createMcpRequestHandler({
        runtimeClient: createRuntimeClient({ executeCli: command => executeCdpCli(command) }),
        sendMessage: message => sent.push(message),
      });
      let mcpDiffShotCount = 0;
      let cliDiffShotCount = 0;
      const runMcpCommand = async command => {
        ensureActive();
        sent.length = 0;
        const commandArgs = command.args.slice(1);
        if (ACTION_PARITY_COMMANDS.has(command.id)) {
          commandArgs[0] = mcpTargetId;
        }
        if (command.id === 'restore') commandArgs[2] = mcpRestorePath;
        if (command.id === 'shot') commandArgs[1] = mcpShotPath;
        if (command.id === 'fullshot') commandArgs[1] = mcpFullshotPath;
        if (command.id === 'responsive-audit') {
          const outDirIndex = commandArgs.indexOf('--out-dir');
          if (outDirIndex < 0) throw new Error('responsive-audit MCP output directory is missing');
          commandArgs[outDirIndex + 1] = mcpResponsiveOutDir;
        }
        if (command.id === 'nav') commandArgs[1] = mcpNavigationUrl;
        const handler = ACTION_PARITY_COMMANDS.has(command.id) ? mcpActionHandler : mcpHandler;
        const invokeMcp = async () => {
          await handler({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'run_command',
              arguments: {
                command: command.id,
                args: commandArgs,
                ...([
                  'components', 'checkpoint', 'cookies', 'console', 'record',
                  'back', 'clickxy', 'clock', 'dialog', 'dismiss-modal', 'fill', 'forward',
                  'hover', 'inject', 'jsclick', 'keepalive', 'mock', 'nav', 'netlog', 'press', 'reload', 'restore', 'scroll',
                  'select', 'throttle', 'type', 'upload', 'verify-click', 'viewport', 'emulate',
                  'shot', 'diff-shot', 'fullshot',
                  'qa', 'responsive-audit',
                ].includes(command.id)
                  ? { confirm: true }
                  : {}),
              },
            },
          });
          ensureActive();
          const response = sent[0];
          if (response?.error) throw new Error(`MCP ${command.id} failed: ${response.error.message}`);
          if (response?.result?.isError) {
            throw new Error(`MCP ${command.id} failed: ${response.result.content?.[0]?.text || 'unknown error'}`);
          }
          const responseText = response?.result?.content?.[0]?.text;
          if (typeof responseText !== 'string') throw new Error(`MCP ${command.id} returned no text`);
          return responseText;
        };
        const text = command.id === 'scanshot'
          ? await withPhase4ScanshotFixture({
            evaluate: expression => runCdp(['eval', mcpTargetPrefix, expression], env, 5_000),
            execute: invokeMcp,
          })
          : await invokeMcp();
        if (command.id === 'verify-click') {
          const resolution = JSON.parse(text).targetResolution;
          if (resolution?.requestedTargetId !== mcpTargetId
            || resolution?.boundTargetId !== mcpTargetId
            || resolution?.resolvedTargetId !== mcpTargetId) {
            throw new Error('MCP verify-click target resolution escaped the independent target');
          }
        }
        if (command.id === 'press') {
          const state = JSON.parse(runCdp(['eval', mcpTargetPrefix, ACTION_STATE_EXPRESSION], env, 5_000));
          assertPhase4ActionState(state, { expectedTitle: EXPECTED_TITLE, modalHidden: true });
        }
        if (['nav', 'back', 'forward'].includes(command.id)) {
          const actualUrl = runCdp(['eval', mcpTargetPrefix, 'location.href'], env, 5_000);
          assertPhase4NavigationState(command.id, actualUrl, { baseUrl: mcpUrl, navigationUrl: mcpNavigationUrl });
        }
        if (command.id === 'reload') {
          const state = JSON.parse(runCdp(['eval', mcpTargetPrefix, RELOAD_STATE_EXPRESSION], env, 5_000));
          assertPhase4ReloadState(state, { navigationUrl: mcpNavigationUrl });
        }
        if (['mock', 'clock', 'throttle'].includes(command.id)) {
          const effect = runCdp(environmentEffectCommand(command.id, mcpTargetPrefix), env, 7_000);
          assertPhase4EnvironmentEffect(command.id, effect);
        }
        if (['viewport', 'emulate'].includes(command.id)) {
          const effect = runCdp(buildPhase4RenderingEffectCommand(command.id, mcpTargetPrefix), env, 5_000);
          assertPhase4RenderingEffect(command.id, effect);
        }
        if (['upload', 'inject', 'restore'].includes(command.id)) {
          const effect = runCdp(buildPhase4ExternalInputEffectCommand(command.id, mcpTargetPrefix), env, 5_000);
          assertPhase4ExternalInputEffect(command.id, effect, { expectedUrl: mcpUrl });
        }
        if (command.id === 'diff-shot' && ++mcpDiffShotCount === 2) {
          const removed = runCdp(['inject', mcpTargetId, '--remove', '--format', 'json'], env, 5_000);
          validateStep('inject', removed, { targetPrefix, expectedTitle: EXPECTED_TITLE, expectedUrl: mcpUrl });
          assertPhase4InjectionRemoved(runCdp([
            'eval', mcpTargetPrefix,
            "JSON.stringify({count:document.querySelectorAll('[data-cdp-inject]').length})",
          ], env, 5_000));
        }
        if (['dialog', 'keepalive', 'netlog'].includes(command.id)) {
          if (runCdp(['eval', mcpTargetPrefix, 'true'], env, 5_000) !== 'true') {
            throw new Error(`MCP ${command.id} left the target runtime unavailable`);
          }
        }
        return text.trim();
      };
      const result = await runPhase4SliceSession({
        targetPrefix,
        expectedTitle: EXPECTED_TITLE,
        expectedUrl: url,
        navigationUrl,
        uploadPath,
        restorePath,
        shotPath,
        fullshotPath,
        responsiveOutDir,
        artifactRoot: runtimeDir,
        runCommand: async command => {
          const output = command.id === 'scanshot'
            ? await withPhase4ScanshotFixture({
              evaluate: expression => runCdp(['eval', targetPrefix, expression], env, 5_000),
              execute: () => runCdp(command.args, env),
            })
            : runCdp(command.args, env);
          if (['nav', 'back', 'forward'].includes(command.id)) {
            const actualUrl = runCdp(['eval', targetPrefix, 'location.href'], env, 5_000);
            assertPhase4NavigationState(command.id, actualUrl, { baseUrl: url, navigationUrl });
          }
          if (command.id === 'reload') {
            const state = JSON.parse(runCdp(['eval', targetPrefix, RELOAD_STATE_EXPRESSION], env, 5_000));
            assertPhase4ReloadState(state, { navigationUrl });
          }
          if (['mock', 'clock', 'throttle'].includes(command.id)) {
            const effect = runCdp(environmentEffectCommand(command.id, targetPrefix), env, 7_000);
            assertPhase4EnvironmentEffect(command.id, effect);
          }
          if (['viewport', 'emulate'].includes(command.id)) {
            const effect = runCdp(buildPhase4RenderingEffectCommand(command.id, targetPrefix), env, 5_000);
            assertPhase4RenderingEffect(command.id, effect);
          }
          if (['cookieset', 'cookiedel'].includes(command.id)) {
            const effect = runCdp(buildPhase4CookieEffectCommand(command.id, targetPrefix), env, 5_000);
            assertPhase4CookieEffect(command.id, effect);
          }
          if (['upload', 'inject', 'restore'].includes(command.id)) {
            const effect = runCdp(buildPhase4ExternalInputEffectCommand(command.id, targetPrefix), env, 5_000);
            assertPhase4ExternalInputEffect(command.id, effect, { expectedUrl: url });
          }
          if (command.id === 'diff-shot' && ++cliDiffShotCount === 2) {
            const removed = runCdp(['inject', targetPrefix, '--remove', '--format', 'json'], env, 5_000);
            validateStep('inject', removed, { targetPrefix, expectedTitle: EXPECTED_TITLE, expectedUrl: url });
            assertPhase4InjectionRemoved(runCdp([
              'eval', targetPrefix,
              "JSON.stringify({count:document.querySelectorAll('[data-cdp-inject]').length})",
            ], env, 5_000));
          }
          if (['dialog', 'keepalive', 'netlog'].includes(command.id)) {
            if (runCdp(['eval', targetPrefix, 'true'], env, 5_000) !== 'true') {
              throw new Error(`${command.id} left the target runtime unavailable`);
            }
          }
          return output;
        },
        runMcpCommand,
        cleanup,
      });
      return `Phase 4 core slices OK: ${browserName}, ${result.commands.length} commands, ${result.extractionParity} MCP extraction parities, click ${result.clickOutcome}`;
    } finally {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      await cleanup();
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runDisposablePhase4Slices().then(output => {
    console.log(output);
  }).catch(error => {
    console.error(`Phase 4 core slices failed: ${error.message}`);
    process.exitCode = 1;
  });
}
