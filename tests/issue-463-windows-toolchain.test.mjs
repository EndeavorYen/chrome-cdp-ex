import { execFile } from 'child_process';
import { createServer } from 'http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, describe, expect, it } from 'vitest';

import { defaultBrowserPaths, detectBrowserPath } from '../skills/chrome-cdp-ex/scripts/lib/browser-paths.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const scratch = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('#463 Windows browser discovery', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    PATH: '',
  };

  it('finds a per-user Chrome or Brave install under %LOCALAPPDATA%', () => {
    const chrome = 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    const brave = 'C:\\Users\\u\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
    expect(detectBrowserPath('chrome', 'win32', { existsSync: p => p === chrome }, env)).toBe(chrome);
    expect(detectBrowserPath('brave', 'win32', { existsSync: p => p === brave }, env)).toBe(brave);
  });

  it('lists Program Files, Program Files (x86) and %LOCALAPPDATA% for every browser', () => {
    expect(defaultBrowserPaths('chrome', 'win32', env)).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ]);
    expect(defaultBrowserPaths('edge', 'win32', env)).toEqual([
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
    ]);
    expect(defaultBrowserPaths('brave', 'win32', env)).toEqual([
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Users\\u\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ]);
  });

  it('follows relocated Program Files roots and never emits a relative path when a variable is unset', () => {
    const paths = defaultBrowserPaths('chrome', 'win32', { ProgramFiles: 'D:\\Apps' });
    expect(paths).toEqual([
      'D:\\Apps\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]);
  });

  it('keeps the macOS and Linux candidates', () => {
    expect(defaultBrowserPaths('edge', 'darwin', {})).toEqual(['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']);
    expect(defaultBrowserPaths('chrome', 'linux', {})).toContain('/usr/bin/google-chrome');
    expect(defaultBrowserPaths('chrome', 'freebsd', {})).toEqual([]);
  });

  // The smoke used to know only POSIX paths and skipped on Windows with Chrome installed.
  it.runIf(process.platform === 'win32')('smoke:live finds a Windows browser without CDP_SMOKE_BROWSER', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chrome-cdp-ex-463-'));
    scratch.push(root);
    const localAppData = join(root, 'Local');
    const chrome = join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe');
    mkdirSync(dirname(chrome), { recursive: true });
    writeFileSync(chrome, '');
    // An occupied port makes the smoke stop right after browser discovery, before it launches anything.
    const server = createServer((_req, res) => res.end('{}'));
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    try {
      // Async: a sync spawn would block this process, so the server could not answer the probe.
      const result = await new Promise((resolveRun, reject) => {
        execFile(process.execPath, [join(rootDir, 'scripts/live-smoke.mjs')], {
          cwd: rootDir,
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            SystemRoot: process.env.SystemRoot,
            PATH: dirname(process.execPath),
            ProgramFiles: join(root, 'pf'),
            'ProgramFiles(x86)': join(root, 'pf86'),
            LOCALAPPDATA: localAppData,
            CDP_SMOKE_PORT: String(server.address().port),
          },
        }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolveRun({ stdout, stderr })));
      });
      expect(result.stdout).not.toContain('no supported Chrome/Edge/Brave browser binary found');
      expect(result.stdout).toContain(`port ${server.address().port} already has a CDP endpoint`);
    } finally {
      server.close();
    }
  }, 60_000);
});
