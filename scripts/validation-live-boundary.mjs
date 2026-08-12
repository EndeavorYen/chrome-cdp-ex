#!/usr/bin/env node

import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { createServer } from 'http';
import { userInfo } from 'os';
import { resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { withLiveBenchmarkLock } from './benchmark-run-lock.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const cdpPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const pagePath = resolve(rootDir, 'scripts/smoke-page.html');

const CFT_LAYOUTS = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-win64/chrome.exe',
  'chrome-win32/chrome.exe',
  'chrome-win/chrome.exe',
];

function defaultCacheRoots() {
  const home = userInfo().homedir;
  return [...new Set([
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    resolve(home, 'Library/Caches/ms-playwright'),
    resolve(home, '.cache/ms-playwright'),
    process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'ms-playwright') : null,
  ].filter(Boolean))];
}

export function discoverBrowserCandidates({ cacheRoots = defaultCacheRoots() } = {}) {
  const candidates = [];
  for (const cacheRoot of cacheRoots) {
    let versions = [];
    try {
      versions = readdirSync(cacheRoot)
        .filter(name => /^chromium-\d+$/.test(name))
        .sort((left, right) => Number(right.slice('chromium-'.length)) - Number(left.slice('chromium-'.length)));
    } catch {}
    for (const version of versions) {
      for (const layout of CFT_LAYOUTS) {
        const path = resolve(cacheRoot, version, layout);
        if (existsSync(path)) candidates.push([path, 'chrome-for-testing']);
      }
    }
  }
  return candidates;
}

export function buildDisposableBrowserArgs({ port, profileDir, url }) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];
}

export function assertLiveBoundary(model, url) {
  if (model?.schema !== 'chrome-cdp-ex.list.v1') throw new Error('list handoff schema is invalid');
  if (!Array.isArray(model.pages)) throw new Error('list handoff pages are missing');
  const page = model.pages.find(entry => entry?.url === url);
  if (!page) throw new Error('disposable loopback page was not listed');
  return {
    targetCount: model.pages.length,
    targetPrefix: page.targetPrefix || null,
    url,
  };
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function stopBrowser(child) {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (!child || exited()) return;
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 10 && !exited(); attempt += 1) await delay(50);
  if (!exited()) child.kill('SIGKILL');
  for (let attempt = 0; attempt < 20 && !exited(); attempt += 1) await delay(50);
  if (!exited()) throw new Error(`disposable browser process ${child.pid} did not exit`);
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
}

export async function runDisposableLiveBoundary() {
  if (!existsSync(cdpPath) || !existsSync(pagePath)) throw new Error('validation live boundary fixtures are missing');
  const candidate = discoverBrowserCandidates()[0];
  if (!candidate) throw new Error('no Chrome for Testing browser binary found');
  const [browserPath, browserName] = candidate;
  return withLiveBenchmarkLock({
    name: 'validation-live-boundary',
    portStart: 9344,
    serverPortStart: 41748,
    browser: browserName,
    profilePrefix: 'chrome-cdp-ex-validation-live',
  }, async run => {
    const { port, serverPort, profileDir } = run.metadata;
    const url = `http://127.0.0.1:${serverPort}/validation-live.html`;
    const server = createServer((request, response) => {
      if (request.url === '/validation-live.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(readFileSync(pagePath));
        return;
      }
      response.writeHead(404);
      response.end('not found');
    });
    let browser = null;
    let browserError = '';
    let cleaning = null;
    const cleanup = () => {
      cleaning ||= (async () => {
        const results = await Promise.allSettled([stopBrowser(browser), closeServer(server)]);
        rmSync(profileDir, { recursive: true, force: true });
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      })();
      return cleaning;
    };
    const onSignal = signal => {
      cleanup().finally(() => process.exit(signal === 'SIGTERM' ? 143 : 130));
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    try {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(serverPort, '127.0.0.1', resolveListen);
      });
      browser = spawn(browserPath, buildDisposableBrowserArgs({ port, profileDir, url }), {
        detached: false,
        env: { ...process.env, HOME: userInfo().homedir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      browser.stderr.on('data', chunk => {
        browserError = `${browserError}${chunk}`.slice(-4096);
      });
      browser.once('error', error => {
        browserError = error.message;
      });
      const env = { ...process.env, CDP_PORT: String(port), NODE_ENV: 'production' };
      let lastError = 'browser did not become reachable';
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (browser.exitCode !== null || browser.signalCode !== null) {
          throw new Error(`disposable browser exited ${browser.exitCode ?? browser.signalCode}: ${browserError.trim() || 'no diagnostics'}`);
        }
        try {
          const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
          if (!version.ok) throw new Error(`CDP version endpoint returned ${version.status}`);
        } catch (error) {
          lastError = error.message;
          await delay(150);
          continue;
        }
        const listed = spawnSync(process.execPath, [cdpPath, 'list', '--format', 'json'], {
          cwd: rootDir,
          env,
          encoding: 'utf8',
          timeout: 5000,
        });
        if (listed.status === 0) {
          try {
            const observation = assertLiveBoundary(JSON.parse(listed.stdout), url);
            return `Disposable live boundary OK: ${browserName}, ${observation.targetCount} target(s)`;
          } catch (error) {
            lastError = error.message;
          }
        } else {
          lastError = listed.stderr.trim() || `cdp list exited ${listed.status}`;
        }
        await delay(150);
      }
      throw new Error(`CDP_REACHABILITY: ${lastError}${browserError.trim() ? `; browser: ${browserError.trim()}` : ''}`);
    } finally {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      await cleanup();
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runDisposableLiveBoundary().then(output => {
    console.log(output);
  }).catch(error => {
    console.error(`Validation live boundary failed: ${error.message}`);
    process.exitCode = 1;
  });
}
