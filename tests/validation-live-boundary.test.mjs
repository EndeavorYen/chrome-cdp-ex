import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  assertLiveBoundary,
  buildDisposableBrowserArgs,
  discoverBrowserCandidates,
} from '../scripts/validation-live-boundary.mjs';

describe('disposable live browser boundary', () => {
  it('always launches headless with an explicit task profile and loopback port', () => {
    expect(buildDisposableBrowserArgs({
      port: 9334,
      profileDir: '/tmp/task-profile',
      url: 'http://127.0.0.1:41738/validation-live.html',
    })).toEqual([
      '--remote-debugging-port=9334',
      '--user-data-dir=/tmp/task-profile',
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      'http://127.0.0.1:41738/validation-live.html',
    ]);
  });

  it('requires the exact loopback page in a versioned list handoff', () => {
    const url = 'http://127.0.0.1:41738/validation-live.html';
    expect(assertLiveBoundary({ schema: 'chrome-cdp-ex.list.v1', pages: [{ url }] }, url)).toEqual({
      targetCount: 1,
      targetPrefix: null,
      url,
    });
    expect(() => assertLiveBoundary({ schema: 'wrong', pages: [{ url }] }, url)).toThrow('schema');
    expect(() => assertLiveBoundary({ schema: 'chrome-cdp-ex.list.v1', pages: [] }, url)).toThrow('loopback page');
  });

  it('prefers a discovered Chrome for Testing binary over installed browsers', () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-cft-test-'));
    const binary = join(cacheRoot, 'chromium-9999', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    mkdirSync(join(binary, '..'), { recursive: true });
    writeFileSync(binary, 'fixture');
    try {
      expect(discoverBrowserCandidates({
        cacheRoots: [cacheRoot],
      })[0]).toEqual([binary, 'chrome-for-testing']);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it('discovers Linux Playwright Chromium layouts without installed-browser fallback', () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-cft-linux-test-'));
    const binary = join(cacheRoot, 'chromium-9999', 'chrome-linux64', 'chrome');
    mkdirSync(join(binary, '..'), { recursive: true });
    writeFileSync(binary, 'fixture');
    try {
      expect(discoverBrowserCandidates({ cacheRoots: [cacheRoot] })).toEqual([
        [binary, 'chrome-for-testing'],
      ]);
      expect(discoverBrowserCandidates({ cacheRoots: [join(cacheRoot, 'missing')] })).toEqual([]);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it('orders Chromium revisions numerically and recognizes x64/win32 layouts', () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-cft-portable-test-'));
    const older = join(cacheRoot, 'chromium-9999', 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    const newer = join(cacheRoot, 'chromium-10000', 'chrome-win32', 'chrome.exe');
    mkdirSync(join(older, '..'), { recursive: true });
    mkdirSync(join(newer, '..'), { recursive: true });
    writeFileSync(older, 'fixture');
    writeFileSync(newer, 'fixture');
    try {
      expect(discoverBrowserCandidates({ cacheRoots: [cacheRoot] })).toEqual([
        [newer, 'chrome-for-testing'],
        [older, 'chrome-for-testing'],
      ]);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
