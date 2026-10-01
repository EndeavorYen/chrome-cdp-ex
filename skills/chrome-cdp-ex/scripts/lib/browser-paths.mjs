import { existsSync as defaultExistsSync } from 'fs';
import { posix as posixPath, win32 as win32Path } from 'path';

// Where Chrome, Edge and Brave install by default. Shared by spawn-debug-browser, doctor and
// scripts/live-smoke.mjs so the runtime and the smoke never disagree about what is installed.
const POSIX_BROWSER_PATHS = {
  darwin: {
    edge:   ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    brave:  ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  },
  linux: {
    edge:   ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge-dev'],
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    brave:  ['/usr/bin/brave-browser', '/usr/bin/brave'],
  },
};

// Windows installs land under Program Files, Program Files (x86), or, for a per-user install
// (Chrome and Brave offer one without admin rights), under %LOCALAPPDATA%.
const WINDOWS_INSTALLS = {
  edge:   { roots: ['x86', 'programFiles', 'localAppData'], path: ['Microsoft', 'Edge', 'Application', 'msedge.exe'] },
  chrome: { roots: ['programFiles', 'x86', 'localAppData'], path: ['Google', 'Chrome', 'Application', 'chrome.exe'] },
  brave:  { roots: ['programFiles', 'x86', 'localAppData'], path: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'] },
};

export const BROWSER_COMMANDS = {
  edge: ['microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-dev', 'msedge'],
  chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'],
  brave: ['brave-browser', 'brave'],
};

export function defaultBrowserPaths(browser, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return [...(POSIX_BROWSER_PATHS[platform]?.[browser] || [])];
  const install = WINDOWS_INSTALLS[browser];
  if (!install) return [];
  const roots = {
    programFiles: env?.ProgramFiles || 'C:\\Program Files',
    x86: env?.['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    // No fallback: an unset %LOCALAPPDATA% must not turn into a path relative to the cwd.
    localAppData: env?.LOCALAPPDATA || '',
  };
  const paths = [];
  for (const key of install.roots) {
    if (!roots[key]) continue;
    const candidate = win32Path.join(roots[key], ...install.path);
    if (!paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

export function findOnPath(commands, env = process.env, fs = { existsSync: defaultExistsSync }, platform = process.platform) {
  const p = platform === 'win32' ? win32Path : posixPath;
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = String(env?.PATH || '').split(sep).filter(Boolean);
  for (const cmd of commands || []) {
    for (const dir of dirs) {
      const candidate = p.resolve(dir, cmd);
      if (fs.existsSync(candidate)) return candidate;
      if (platform === 'win32' && fs.existsSync(`${candidate}.exe`)) return `${candidate}.exe`;
    }
  }
  return null;
}

export function detectBrowserPath(browser, platform = process.platform, fs = { existsSync: defaultExistsSync }, env = process.env) {
  for (const candidate of defaultBrowserPaths(browser, platform, env)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return findOnPath(BROWSER_COMMANDS[browser] || [], env, fs, platform);
}
